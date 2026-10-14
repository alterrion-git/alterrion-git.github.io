// ============================================================================
// CWA AI proxy — Cloudflare Worker (Workers AI)
// ============================================================================
// Runs the models ON Cloudflare (Workers AI), so there is no external API key
// and no third-party regional free-tier limits.
//
// Two jobs:
//  1. AI Coach chat / text: POST { system, prompt | messages, user, maxTokens }
//     → { text, model, fallback? }  (fallback: why the models before `model` didn't answer)
//  2. Food photos (nutrition labels / products / plates):
//     POST { task: 'food-photo', image: 'data:image/jpeg;base64,...', user }
//     → { food: { name, brand, barcode, unit, source, per100: {...}, servingGrams, confidence }, model }
//
// Setup (see proxy/README.md):
//   - Add a Workers AI binding named  AI  (Worker > Settings > Bindings).
//   - Optional plain var  AI_MODEL      (chat model; tried before the defaults).
//   - Optional plain var  VISION_MODEL  (food-photo model; tried first).
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
// Vision models that take OpenAI-style image_url content parts, tried in order
// until one answers (the catalog changes; VISION_MODEL lets you pin one).
const VISION_MODELS = [
  '@cf/meta/llama-4-scout-17b-16e-instruct',
  '@cf/mistralai/mistral-small-3.1-24b-instruct',
  '@cf/google/gemma-3-12b-it',
];
// Last resort: older vision model with a separate `image` field.
const LEGACY_VISION_MODEL = '@cf/meta/llama-3.2-11b-vision-instruct';

const FOOD_PHOTO_PROMPT = `You read food photos for a nutrition tracker. First decide what the photo shows:
"label" = a nutrition facts table is visible (often Czech: "Výživové údaje", "Energetická hodnota", "Tuky", "z toho nasycené mastné kyseliny", "Sacharidy", "z toho cukry", "Vláknina", "Bílkoviny", "Sůl"),
"package" = a packaged product without a readable nutrition table,
"meal" = a plate or prepared dish, "food" = an unpackaged food (fruit, bread, meat...).
Return ONLY one JSON object, no other text:
{"kind": "label"|"package"|"meal"|"food", "name": string, "brand": string|null, "searchText": string,
 "barcode": string|null, "unit": "g"|"ml", "source": "label"|"estimate",
 "per100": {"kcal": number, "protein": number, "carbs": number, "sugar": number, "fat": number, "fibre": number, "salt": number},
 "servingGrams": number|null, "confidence": "high"|"medium"|"low"}
Rules:
- searchText: the brand and product name exactly as printed on the package (e.g. "Olma Florian jogurt bílý"), used to look the product up in a database. Copy the printed words; never invent a brand you cannot read. For meals/food: the food's common name.
- per100 is per 100 g (or 100 ml for drinks). If the table shows only per portion, convert using the portion size. If only kJ is shown, kcal = kJ / 4.184. If only sodium is shown, salt = sodium * 2.5.
- source = "label" only when the numbers come from a visible nutrition table. Otherwise give typical values for that kind of food, source = "estimate", confidence "low" for packages.
- For a meal, estimate per100 for the whole dish and the total portion weight in servingGrams.
- barcode = the digits printed under a visible barcode, else null. Use null for anything unknown.
- Keep names in the language printed on the package (Czech is fine).`;

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

    if (!env.AI || typeof env.AI.run !== 'function') {
      return json({ error: 'Worker is missing the "AI" binding (Workers AI). Add it in Settings > Bindings.' }, 500);
    }

    let body;
    try { body = await request.json(); } catch (e) { return json({ error: 'Bad JSON' }, 400); }
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

    const DAILY_LIMIT = parseInt(env.DAILY_LIMIT || '5', 10);
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

function parseFoodJson(text) {
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start < 0 || end <= start) return null;
  try { return JSON.parse(text.slice(start, end + 1)); } catch (e) { return null; }
}

async function foodPhoto(env, image, json) {
  const models = [env.VISION_MODEL, ...VISION_MODELS].filter((m, i, a) => m && a.indexOf(m) === i);
  const errors = [];
  for (const model of models) {
    try {
      const out = await env.AI.run(model, {
        messages: [{ role: 'user', content: [
          { type: 'text', text: FOOD_PHOTO_PROMPT },
          { type: 'image_url', image_url: { url: image } },
        ] }],
        max_tokens: 600,
        temperature: 0.1,
      });
      const food = parseFoodJson(responseText(out));
      if (food) return json({ food, model });
      errors.push(`${model}: no JSON in reply`);
    } catch (e) {
      errors.push(`${model}: ${e && e.message ? e.message : e}`);
    }
  }
  // Older model: image passed separately as bytes; needs a one-time license "agree".
  try {
    const bytes = Uint8Array.from(atob(image.split(',')[1]), (c) => c.charCodeAt(0));
    const run = () => env.AI.run(LEGACY_VISION_MODEL, {
      messages: [{ role: 'user', content: FOOD_PHOTO_PROMPT }],
      image: [...bytes],
      max_tokens: 600,
      temperature: 0.1,
    });
    let out;
    try { out = await run(); } catch (e) {
      if (!/agree/i.test(String(e && e.message))) throw e;
      await env.AI.run(LEGACY_VISION_MODEL, { prompt: 'agree' });
      out = await run();
    }
    const food = parseFoodJson(responseText(out));
    if (food) return json({ food, model: LEGACY_VISION_MODEL });
    errors.push(`${LEGACY_VISION_MODEL}: no JSON in reply`);
  } catch (e) {
    errors.push(`${LEGACY_VISION_MODEL}: ${e && e.message ? e.message : e}`);
  }
  return json({ error: 'Could not read the photo. ' + errors.join(' | ').slice(0, 600) }, 502);
}
