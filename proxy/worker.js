// ============================================================================
// CWA AI Recap proxy — Cloudflare Worker
// ============================================================================
// Holds your Google Gemini API key server-side so it never ships in the app.
// The app POSTs { system, prompt, maxTokens }; this calls Gemini and returns
// { text }. Free to run on Cloudflare's Workers free tier; Gemini Flash has a
// free API tier. See proxy/README.md for 5-minute deploy steps.
//
// Secrets / vars to set in the Worker (Settings > Variables):
//   GEMINI_API_KEY  (secret)  — from https://aistudio.google.com/apikey
//   GEMINI_MODEL    (plain, optional) — defaults to 'gemini-2.0-flash'
//   ALLOW_ORIGIN    (plain, optional) — defaults to the GitHub Pages origin

const DEFAULT_ALLOW = 'https://alterrion-git.github.io';
const DEFAULT_MODEL = 'gemini-2.0-flash';

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

    if (!env.GEMINI_API_KEY) return json({ error: 'Server missing GEMINI_API_KEY' }, 500);

    let body;
    try { body = await request.json(); } catch (e) { return json({ error: 'Bad JSON' }, 400); }

    const system = String(body.system || '').slice(0, 4000);
    const prompt = String(body.prompt || '').slice(0, 12000);
    const maxTokens = Math.min(Math.max(parseInt(body.maxTokens, 10) || 900, 64), 2048);
    if (!prompt) return json({ error: 'Empty prompt' }, 400);

    const model = env.GEMINI_MODEL || DEFAULT_MODEL;
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${env.GEMINI_API_KEY}`;
    const payload = {
      contents: [{ role: 'user', parts: [{ text: prompt }] }],
      generationConfig: { temperature: 0.6, maxOutputTokens: maxTokens },
    };
    if (system) payload.system_instruction = { parts: [{ text: system }] };

    let g;
    try {
      g = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });
    } catch (e) {
      return json({ error: 'Could not reach the model service' }, 502);
    }

    let data = {};
    try { data = await g.json(); } catch (e) {}
    if (!g.ok) {
      const msg = (data && data.error && data.error.message) || `Model error (${g.status})`;
      return json({ error: msg }, g.status);
    }

    const cand = data.candidates && data.candidates[0];
    const text = cand && cand.content && cand.content.parts
      ? cand.content.parts.map(p => p.text || '').join('')
      : '';
    if (!text) {
      // e.g. blocked by safety filters
      const reason = (cand && cand.finishReason) || 'no content';
      return json({ error: `Empty response (${reason})` }, 502);
    }
    return json({ text });
  },
};
