// ============================================================================
// CWA AI Recap proxy — Cloudflare Worker (Workers AI)
// ============================================================================
// Runs the model ON Cloudflare (Workers AI), so there is no external API key
// and no third-party regional free-tier limits (Gemini's free tier is 0 in
// some regions, e.g. the EU — this avoids that entirely). Free daily
// allocation is plenty for gated weekly/monthly recaps.
//
// The app POSTs { system, prompt, maxTokens } and gets back { text } — the same
// contract as before, so nothing in the app changes.
//
// Setup (see proxy/README.md):
//   - Add a Workers AI binding named  AI  (Worker > Settings > Bindings).
//   - Optional plain var  AI_MODEL     (defaults to a good free Llama model).
//   - Optional plain var  ALLOW_ORIGIN (defaults to the GitHub Pages origin).

const DEFAULT_ALLOW = 'https://alterrion-git.github.io';
// Override with the AI_MODEL var if this is ever deprecated. See the current
// catalog: https://developers.cloudflare.com/workers-ai/models/
const DEFAULT_MODEL = '@cf/meta/llama-3.3-70b-instruct-fp8-fast';

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

    const system = String(body.system || '').slice(0, 6000);
    const prompt = String(body.prompt || '').slice(0, 12000);
    const turns = Array.isArray(body.messages) ? body.messages : null; // chat history
    const user = String(body.user || '').slice(0, 128);
    const maxTokens = Math.min(Math.max(parseInt(body.maxTokens, 10) || 700, 64), 2048);
    if (!turns && !prompt) return json({ error: 'Empty prompt' }, 400);

    // Optional server-side daily cap per user. Only active if a KV namespace is
    // bound as RL (Settings > Bindings > KV namespace, variable name RL). Without
    // it, the app's client-side 5/day limit still applies.
    const DAILY_LIMIT = parseInt(env.DAILY_LIMIT || '5', 10);
    if (env.RL && user) {
      const day = new Date().toISOString().slice(0, 10);
      const key = `rl:${user}:${day}`;
      const used = parseInt((await env.RL.get(key)) || '0', 10);
      if (used >= DAILY_LIMIT) return json({ error: `Daily message limit reached (${DAILY_LIMIT}/day). Resets tomorrow.` }, 429);
      // best-effort increment; expires after 2 days
      try { await env.RL.put(key, String(used + 1), { expirationTtl: 172800 }); } catch (e) {}
    }

    const model = env.AI_MODEL || DEFAULT_MODEL;
    const messages = [];
    if (system) messages.push({ role: 'system', content: system });
    if (turns) {
      for (const m of turns.slice(-24)) {
        if (m && (m.role === 'user' || m.role === 'assistant') && typeof m.content === 'string' && m.content) {
          messages.push({ role: m.role, content: m.content.slice(0, 6000) });
        }
      }
    } else {
      messages.push({ role: 'user', content: prompt });
    }
    if (messages.length === (system ? 1 : 0)) return json({ error: 'No message content' }, 400);

    let out;
    try {
      out = await env.AI.run(model, { messages, max_tokens: maxTokens, temperature: 0.6 });
    } catch (e) {
      return json({ error: 'Model error: ' + (e && e.message ? e.message : String(e)) }, 502);
    }

    // Workers AI returns { response: "..." } for chat models.
    const text = (out && (out.response || out.result || out.text)) || '';
    if (!text) return json({ error: 'Empty response from model' }, 502);
    return json({ text });
  },
};
