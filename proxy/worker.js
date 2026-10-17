// ============================================================================
// CWA AI proxy — Cloudflare Worker (Workers AI)
// ============================================================================
// Runs the models ON Cloudflare (Workers AI), so there is no external API key
// and no third-party regional free-tier limits.
//
// Jobs:
//  1. AI Coach chat / text: POST { system, prompt | messages, user, maxTokens }
//     → { text, model, fallback? }  (fallback: why the models before `model` didn't answer)
//  2. Food photos (nutrition labels / products / plates), read in two steps (vision model
//     → gpt-oss, see VISION_MODELS): POST { task: 'food-photo', image: 'data:image/jpeg;base64,...', user }
//     → { food: { name, brand, barcode, unit, source, per100: {...}, servingGrams, confidence }, model, fallback? }
//  3. Open Food Facts, server side (the app's fallback when OFF doesn't answer the browser):
//     POST { task: 'off-search', q } → { products: [...], source }
//     POST { task: 'off-product', code } → OFF's product JSON ({ status, product })
//
// Setup (see proxy/README.md):
//   - Add a Workers AI binding named  AI  (Worker > Settings > Bindings).
//   - Optional plain var  AI_MODEL      (chat model; tried before the defaults).
//   - Optional plain var  VISION_MODEL  (food-photo model that reads the photo; tried first).
//   - Optional plain var  NUTRITION_MODEL (works out a photo's numbers; default gpt-oss-120b).
//   - Optional plain var  ALLOW_ORIGIN  (defaults to the GitHub Pages origin).

const DEFAULT_ALLOW = 'https://alterrion-git.github.io';
// Chat models, best first: the first that answers is used, so a model that is renamed or
// retired just falls through to the next. gpt-oss-120b (OpenAI's open-weight reasoning
// model) coaches noticeably better than Llama 3.3 70B, which stays as the fallback. Set the
// AI_MODEL var to put another model in front. Catalog:
// https://developers.cloudflare.com/workers-ai/models/
const CHAT_MODELS = [
  '@cf/openai/gpt-oss-120b',
  '@cf/meta/llama-3.3-70b-instruct-fp8-fast',
];
// Vision models that take OpenAI-style image_url content parts, tried in order until one
// answers (the catalog changes; VISION_MODEL lets you pin one). Gemma 4 (Apr 2026) reads
// labels (OCR) much better than the older ones. gpt-oss can't see images, so a photo is read
// in two steps: a vision model writes down what it sees (the nutrition table verbatim, or the
// plate's items and weights), then the chat model (gpt-oss) works out the numbers from that.
const VISION_MODELS = [
  '@cf/google/gemma-4-26b-a4b-it',
  '@cf/meta/llama-4-scout-17b-16e-instruct',
  '@cf/mistralai/mistral-small-3.1-24b-instruct',
  '@cf/google/gemma-3-12b-it',
];
// Last resort: older vision model with a separate `image` field.
const LEGACY_VISION_MODEL = '@cf/meta/llama-3.2-11b-vision-instruct';

// Step 1 (vision model): what the photo shows, copied down rather than worked out, plus the
// model's own rough numbers (used only if step 2 fails).
const FOOD_PHOTO_PROMPT = `You look at food photos for a nutrition tracker and write down exactly what you see. First decide what the photo shows:
"label" = a nutrition facts table is visible (often Czech: "Výživové údaje", "Energetická hodnota", "Tuky", "z toho nasycené mastné kyseliny", "Sacharidy", "z toho cukry", "Vláknina", "Bílkoviny", "Sůl"),
"package" = a packaged product without a readable nutrition table,
"meal" = a plate or prepared dish, "food" = an unpackaged food (fruit, bread, meat...).
Return ONLY one JSON object, no other text:
{"kind": "label"|"package"|"meal"|"food", "name": string, "brand": string|null, "searchText": string,
 "barcode": string|null, "unit": "g"|"ml",
 "labelText": string|null, "servingText": string|null,
 "items": [{"food": string, "grams": number}], "notes": string,
 "source": "label"|"estimate",
 "per100": {"kcal": number, "protein": number, "carbs": number, "sugar": number, "fat": number, "fibre": number, "salt": number},
 "servingGrams": number|null, "confidence": "high"|"medium"|"low"}
Rules:
- labelText: the whole nutrition table copied exactly as printed, one row per line, every column with its header (e.g. "na 100 g | na porci 30 g"), numbers and units exactly as printed (keep decimal commas). null if no table is visible.
- servingText: the portion / package size as printed, else null.
- items (meals and food): each component you can see with its estimated weight in grams (look at the plate size, cutlery, hands). notes: cooking method, oil, sauces, anything that changes calories.
- searchText: the brand and product name exactly as printed on the package (e.g. "Olma Florian jogurt bílý"), used to look the product up in a database. Copy the printed words; never invent a brand you cannot read. For meals/food: the food's common name.
- per100: your own rough values per 100 g (or 100 ml for drinks); servingGrams: the portion weight. source = "label" only when the numbers come from a visible table.
- barcode = the digits printed under a visible barcode, else null. Use null for anything unknown.
- Keep names in the language printed on the package (Czech is fine).`;

// Step 2 (chat model, gpt-oss): the numbers, worked out from step 1's notes.
const FOOD_NUTRITION_PROMPT = `You turn what a vision model saw in a food photo into nutrition values for a tracker. You get its notes as JSON: kind, name, brand, labelText (the nutrition table as printed), servingText, items (components with estimated grams), notes, and its own rough per100 guess.
Work it out carefully, then return ONLY one JSON object, no other text:
{"kind": "label"|"package"|"meal"|"food", "name": string, "brand": string|null, "searchText": string, "barcode": string|null, "unit": "g"|"ml",
 "source": "label"|"estimate",
 "per100": {"kcal": number, "protein": number, "carbs": number, "sugar": number, "fat": number, "fibre": number, "salt": number},
 "servingGrams": number|null, "confidence": "high"|"medium"|"low"}
Rules:
- With labelText: use the per 100 g (or 100 ml) column. If there is only a per-portion column, convert with the portion size (servingText). kJ only → kcal = kJ / 4.184. Sodium only → salt = sodium × 2.5. Decimal commas are decimal points. Check kcal ≈ 4×protein + 4×carbs + 9×fat (+ 2×fibre); if a value is clearly misread (e.g. a lost decimal comma: 25 instead of 2,5), correct it. source = "label", confidence "high" unless the table was incomplete.
- Meal or food: estimate per 100 g of the whole portion from the items and their grams, with typical values for each component (include oil and sauces from the notes); servingGrams = total grams. source = "estimate".
- Package without a table: typical values for that kind of product; source "estimate", confidence "low".
- Keep name, brand, searchText and barcode from the notes unless clearly wrong. per100 values are plain numbers (no units); null when unknown.`;

export default {
  async fetch(request, env) {
    const allow = env.ALLOW_ORIGIN || DEFAULT_ALLOW;
    const cors = {
      'Access-Control-Allow-Origin': allow,
      'Access-Control-Allow-Methods': 'POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
      'Vary': 'Origin',
    };
    const json = (obj, status = 200) =>
      new Response(JSON.stringify(obj), { status, headers: { ...cors, 'Content-Type': 'application/json' } });

    if (request.method === 'OPTIONS') return new Response(null, { headers: cors });
    if (request.method !== 'POST') return json({ error: 'Method not allowed' }, 405);

    // Light abuse guard: only allow requests from the app origin (browsers send Origin).
    const origin = request.headers.get('Origin');
    if (origin && origin !== allow) return json({ error: 'Forbidden origin' }, 403);

    let body;
    try { body = await request.json(); } catch (e) { return json({ error: 'Bad JSON' }, 400); }

    if (body.task === 'off-search' || body.task === 'off-product') return offProxy(body, json);

    if (!env.AI || typeof env.AI.run !== 'function') {
      return json({ error: 'Worker is missing the "AI" binding (Workers AI). Add it in Settings > Bindings.' }, 500);
    }
    const user = String(body.user || '').slice(0, 128);

    // Optional server-side daily caps per user. Only active if a KV namespace is
    // bound as RL (Settings > Bindings > KV namespace, variable name RL). Without
    // it, the app's client-side limits still apply.
    const overLimit = async (prefix, limit) => {
      if (!env.RL || !user) return false;
      const day = new Date().toISOString().slice(0, 10);
      const key = `${prefix}:${user}:${day}`;
      const used = parseInt((await env.RL.get(key)) || '0', 10);
      if (used >= limit) return true;
      try { await env.RL.put(key, String(used + 1), { expirationTtl: 172800 }); } catch (e) {}
      return false;
    };

    if (body.task === 'food-photo') {
      const image = String(body.image || '');
      if (!/^data:image\/(jpeg|png|webp);base64,/.test(image)) return json({ error: 'Expected a base64 image data URL' }, 400);
      if (image.length > 4_000_000) return json({ error: 'Image too large' }, 413);
      const limit = parseInt(env.VISION_DAILY_LIMIT || '30', 10);
      if (await overLimit('rlv', limit)) return json({ error: `Daily photo limit reached (${limit}/day). Resets tomorrow.` }, 429);
      return foodPhoto(env, image, json);
    }

    // The app's context (profile, food diary, program, recent sets) runs to several thousand
    // characters; 24k chars is ~6k tokens, well inside both chat models' context windows.
    const system = String(body.system || '').slice(0, 24000);
    const prompt = String(body.prompt || '').slice(0, 12000);
    const turns = Array.isArray(body.messages) ? body.messages : null; // chat history
    const maxTokens = Math.min(Math.max(parseInt(body.maxTokens, 10) || 700, 64), 2048);
    if (!turns && !prompt) return json({ error: 'Empty prompt' }, 400);

    const DAILY_LIMIT = parseInt(env.DAILY_LIMIT || '10', 10);
    if (await overLimit('rl', DAILY_LIMIT)) return json({ error: `Daily message limit reached (${DAILY_LIMIT}/day). Resets tomorrow.` }, 429);

    const msgs = [];
    if (turns) {
      for (const m of turns.slice(-24)) {
        if (m && (m.role === 'user' || m.role === 'assistant') && typeof m.content === 'string' && m.content) {
          msgs.push({ role: m.role, content: m.content.slice(0, 6000) });
        }
      }
    } else {
      msgs.push({ role: 'user', content: prompt });
    }
    if (!msgs.length) return json({ error: 'No message content' }, 400);

    const models = [env.AI_MODEL, ...CHAT_MODELS].filter((m, i, a) => m && a.indexOf(m) === i);
    const errors = [];
    for (const model of models) {
      try {
        const text = await chat(env, model, system, msgs, maxTokens);
        if (text) return json(errors.length ? { text, model, fallback: errors.join(' | ').slice(0, 600) } : { text, model });
        errors.push(`${model}: empty reply`);
      } catch (e) {
        errors.push(`${model}: ${e && e.message ? e.message : e}`);
      }
      console.log('chat model failed:', errors[errors.length - 1]); // shows in the Worker's logs
    }
    return json({ error: 'Model error: ' + errors.join(' | ').slice(0, 600) }, 502);
  },
};

// One chat turn on one model → reply text ('' if it said nothing).
async function chat(env, model, system, msgs, maxTokens) {
  const messages = system ? [{ role: 'system', content: system }, ...msgs] : msgs;
  if (/gpt-oss/.test(model)) {
    // gpt-oss always reasons first, and max_tokens covers the reasoning too, so it gets far
    // more room than the visible answer needs (a small cap leaves the answer empty).
    let firstError = null;
    try {
      const text = responseText(await env.AI.run(model, { messages, max_tokens: Math.max(4096, maxTokens * 4) }));
      if (text) return text;
    } catch (e) { firstError = e; }
    // The model's other input shape: OpenAI Responses API (system prompt as a message).
    try {
      return responseText(await env.AI.run(model, { input: messages, reasoning: { effort: 'medium' } }));
    } catch (e) { throw firstError || e; }
  }
  return responseText(await env.AI.run(model, { messages, max_tokens: maxTokens, temperature: 0.6 }));
}

// Workers AI chat models return { response: "..." } (some an already-parsed object),
// OpenAI-style ones { choices: [{ message: { content } }] }, and Responses-API ones (gpt-oss)
// { output: [{ type: 'reasoning', ... }, { type: 'message', content: [{ type: 'output_text', text }] }] }.
function responseText(out) {
  if (!out) return '';
  if (typeof out === 'string') return out.trim();
  if (typeof out.output_text === 'string' && out.output_text.trim()) return out.output_text.trim();
  if (Array.isArray(out.output)) {
    const text = out.output.filter((o) => o && o.type === 'message')
      .flatMap((o) => (Array.isArray(o.content) ? o.content : []))
      .filter((c) => c && (c.type === 'output_text' || c.type === 'text') && typeof c.text === 'string')
      .map((c) => c.text).join('').trim();
    if (text) return text;
  }
  const r = out.response ?? out.result ?? out.text;
  if (r && typeof r === 'object') return JSON.stringify(r);
  if (typeof r === 'string') return r.trim();
  const c = out.choices && out.choices[0] && out.choices[0].message && out.choices[0].message.content;
  return typeof c === 'string' ? c.trim() : '';
}

// The last complete {...} in a reply that looks like our object (a model may think out loud,
// or wrap it in ``` fences, before it).
function parseFoodJson(text) {
  if (!text) return null;
  const t = String(text);
  let best = null;
  for (let start = t.indexOf('{'); start >= 0; start = t.indexOf('{', start + 1)) {
    let depth = 0, inStr = false, esc = false;
    for (let i = start; i < t.length; i++) {
      const ch = t[i];
      if (inStr) { if (esc) esc = false; else if (ch === '\\') esc = true; else if (ch === '"') inStr = false; continue; }
      if (ch === '"') inStr = true;
      else if (ch === '{') depth++;
      else if (ch === '}' && --depth === 0) {
        try { const o = JSON.parse(t.slice(start, i + 1)); if (o && typeof o === 'object' && ('per100' in o || 'kind' in o)) best = o; } catch (e) {}
        break;
      }
    }
  }
  return best;
}

const shortModel = (m) => String(m || '').split('/').pop();

async function foodPhoto(env, image, json) {
  // Step 1: a vision model reads the photo.
  const look = await readPhoto(env, image);
  if (!look.food) return json({ error: 'Could not read the photo. ' + look.errors.join(' | ').slice(0, 600) }, 502);
  // Step 2: the chat model works out the numbers. If it can't, the vision model's own ones.
  const seen = look.food;
  const notes = JSON.stringify({
    kind: seen.kind, name: seen.name, brand: seen.brand, searchText: seen.searchText, barcode: seen.barcode, unit: seen.unit,
    labelText: seen.labelText, servingText: seen.servingText, items: seen.items, notes: seen.notes,
    roughGuess: { per100: seen.per100, servingGrams: seen.servingGrams },
  });
  const chatModel = env.NUTRITION_MODEL || CHAT_MODELS[0];
  let detail = '';
  try {
    const text = await chat(env, chatModel, FOOD_NUTRITION_PROMPT, [{ role: 'user', content: notes.slice(0, 8000) }], 1200);
    const worked = parseFoodJson(text);
    if (worked && worked.per100 && worked.per100.kcal != null) {
      const food = { ...seen, ...worked, name: worked.name || seen.name, brand: worked.brand ?? seen.brand, searchText: worked.searchText || seen.searchText, barcode: worked.barcode ?? seen.barcode };
      return json({ food, model: `${shortModel(look.model)} + ${shortModel(chatModel)}` });
    }
    detail = `${shortModel(chatModel)}: no usable JSON`;
  } catch (e) {
    detail = `${shortModel(chatModel)}: ${e && e.message ? e.message : e}`;
  }
  console.log('food-photo step 2 failed:', detail);
  return json({ food: seen, model: shortModel(look.model), fallback: detail });
}

// → { food, model } from the first vision model that answers, or { errors }.
async function readPhoto(env, image) {
  const models = [env.VISION_MODEL, ...VISION_MODELS].filter((m, i, a) => m && a.indexOf(m) === i);
  const errors = [];
  for (const model of models) {
    try {
      const out = await env.AI.run(model, {
        messages: [{ role: 'user', content: [
          { type: 'text', text: FOOD_PHOTO_PROMPT },
          { type: 'image_url', image_url: { url: image } },
        ] }],
        max_tokens: 1500,
        temperature: 0.1,
      });
      const food = parseFoodJson(responseText(out));
      if (food) return { food, model };
      errors.push(`${shortModel(model)}: no JSON in reply`);
    } catch (e) {
      errors.push(`${shortModel(model)}: ${e && e.message ? e.message : e}`);
    }
    console.log('vision model failed:', errors[errors.length - 1]);
  }
  // Older model: image passed separately as bytes; needs a one-time license "agree".
  try {
    const bytes = Uint8Array.from(atob(image.split(',')[1]), (c) => c.charCodeAt(0));
    const run = () => env.AI.run(LEGACY_VISION_MODEL, {
      messages: [{ role: 'user', content: FOOD_PHOTO_PROMPT }],
      image: [...bytes],
      max_tokens: 1500,
      temperature: 0.1,
    });
    let out;
    try { out = await run(); } catch (e) {
      if (!/agree/i.test(String(e && e.message))) throw e;
      await env.AI.run(LEGACY_VISION_MODEL, { prompt: 'agree' });
      out = await run();
    }
    const food = parseFoodJson(responseText(out));
    if (food) return { food, model: LEGACY_VISION_MODEL };
    errors.push(`${shortModel(LEGACY_VISION_MODEL)}: no JSON in reply`);
  } catch (e) {
    errors.push(`${shortModel(LEGACY_VISION_MODEL)}: ${e && e.message ? e.message : e}`);
  }
  return { errors };
}

// ---------- Open Food Facts proxy ----------
// OFF asks API clients for a User-Agent naming the app (browsers can't set one), its legacy
// search (cgi/search.pl) often answers 503, and its newer search service (Search-a-licious)
// may not allow other sites' pages. Here: Search-a-licious first, the legacy search as a
// fallback, product lookups by barcode; answers cached for a day where the Cache API works.
const OFF_UA = 'CWA-Workout-App/1.0 (https://alterrion-git.github.io)';
const OFF_FIELDS = 'code,product_name,product_name_cs,product_name_en,generic_name,brands,quantity,serving_size,serving_quantity,nutriments,countries_tags';

async function offFetch(url, ms) {
  const res = await fetch(url, { headers: { 'User-Agent': OFF_UA, Accept: 'application/json' }, signal: AbortSignal.timeout(ms) });
  return res;
}

async function offProxy(body, json) {
  const cache = typeof caches !== 'undefined' ? caches.default : null;
  let cacheKey, out, status = 200;
  if (body.task === 'off-product') {
    const code = String(body.code || '').replace(/\D/g, '').slice(0, 14);
    if (code.length < 8) return json({ error: 'Bad barcode' }, 400);
    cacheKey = `https://cwa-cache.invalid/off-product/${code}`;
  } else {
    const q = String(body.q || '').trim().slice(0, 100);
    if (q.length < 2) return json({ error: 'Empty search' }, 400);
    cacheKey = `https://cwa-cache.invalid/off-search?q=${encodeURIComponent(q.toLowerCase())}`;
  }
  try { const hit = cache && await cache.match(cacheKey); if (hit) return json(await hit.json()); } catch (e) {}

  if (body.task === 'off-product') {
    const code = cacheKey.split('/').pop();
    try {
      const res = await offFetch(`https://world.openfoodfacts.org/api/v2/product/${code}.json?fields=${OFF_FIELDS}`, 9000);
      if (res.status === 404) out = { status: 0, code };
      else if (!res.ok) return json({ error: `Open Food Facts error (${res.status})` }, 502);
      else out = await res.json();
    } catch (e) { return json({ error: 'Open Food Facts did not answer' }, 504); }
  } else {
    const q = String(body.q || '').trim().slice(0, 100);
    const errors = [];
    try {
      const res = await offFetch(`https://search.openfoodfacts.org/search?q=${encodeURIComponent(q)}&langs=cs,en&page_size=30&fields=${OFF_FIELDS}`, 9000);
      if (!res.ok) throw new Error('search-a-licious ' + res.status);
      const data = await res.json();
      if (!Array.isArray(data.hits)) throw new Error('search-a-licious: no hits');
      out = { products: data.hits, source: 'search-a-licious' };
    } catch (e) { errors.push(String(e.message || e)); }
    if (!out || !out.products.length) {
      try {
        const res = await offFetch(`https://world.openfoodfacts.org/cgi/search.pl?search_terms=${encodeURIComponent(q)}&search_simple=1&action=process&json=1&page_size=30&fields=${OFF_FIELDS}`, 15000);
        if (!res.ok) throw new Error('legacy search ' + res.status);
        const data = await res.json();
        out = { products: data.products || [], source: 'legacy' };
      } catch (e) { errors.push(String(e.message || e)); }
    }
    if (!out) return json({ error: 'Open Food Facts search failed', errors }, 502);
  }
  try { if (cache) await cache.put(cacheKey, new Response(JSON.stringify(out), { headers: { 'Content-Type': 'application/json', 'Cache-Control': 'max-age=86400' } })); } catch (e) {}
  return json(out, status);
}
