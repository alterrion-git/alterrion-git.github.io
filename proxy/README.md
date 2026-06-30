# CWA AI Recap proxy (Cloudflare Worker + Workers AI)

This tiny Worker runs the recap model **on Cloudflare (Workers AI)**. There is
**no external API key** and **no regional free-tier limits** (Google's Gemini
free tier is unavailable / `limit: 0` in some regions like the EU — this avoids
that). The free daily allocation easily covers gated weekly/monthly recaps.

The app sends `{ system, prompt, maxTokens }` (text only) and gets `{ text }`.

## 1. Create the Worker
1. Sign up free at <https://workers.cloudflare.com> (no card).
2. **Workers & Pages → Create → Workers → "Start with Hello World!"** → name it
   (e.g. `cwa-recap`) → **Deploy** → **Edit code**.
3. Delete the starter code, paste [`worker.js`](./worker.js), **Deploy**.

## 2. Add the Workers AI binding (this is the important step)
In the Worker → **Settings → Bindings → Add binding → Workers AI**:
- **Variable name:** `AI`  (exactly that)
- Save, then **Deploy** again.

That's it — no API key needed. Workers AI is billed in "neurons"; the free
allocation (10,000 neurons/day) is far more than gated recaps use.

### Optional
- Plain variable `AI_MODEL` to change the model. Default is
  `@cf/meta/llama-3.1-8b-instruct` (fast, low cost). For higher quality try
  `@cf/meta/llama-3.3-70b-instruct-fp8-fast`.
- Plain variable `ALLOW_ORIGIN` if the app isn't on
  `https://alterrion-git.github.io`.

## 3. Point the app at it
Copy the Worker URL (e.g. `https://cwa-recap.<you>.workers.dev`) into
`index.html`:

```js
const LLM_PROXY_URL = 'https://cwa-recap.<you>.workers.dev';
```

Then in the app: **Profile → Settings → AI Recaps → Test connection** should say
"Recap service works ✓".

## Test from a terminal (optional)
```bash
curl -X POST https://cwa-recap.<you>.workers.dev \
  -H 'Content-Type: application/json' \
  -H 'Origin: https://alterrion-git.github.io' \
  -d '{"system":"You are a coach.","prompt":"Say hi in one sentence."}'
```
Expect `{"text":"..."}`.

## Notes
- The Worker only accepts requests whose `Origin` is your app (stops casual
  browser abuse). For a fully public release, add a shared secret or
  Cloudflare rate-limiting.
- Swap models any time via `AI_MODEL`; the app never changes.
