# CWA AI Recap proxy (Cloudflare Worker + Gemini)

This tiny Worker holds your **Google Gemini API key** so the app never exposes
it. The app sends text only (workout/metrics summary); the Worker calls Gemini
and returns the recap text. Both the Worker and the Gemini free tier cost **$0**
at this app's scale, and **no credit card** is required.

## 1. Get a free Gemini API key
1. Go to <https://aistudio.google.com/apikey> (sign in with Google).
2. **Create API key** → copy it (starts with `AIza…`). The free tier is enabled
   by default — no billing needed.

## 2. Create the Cloudflare Worker
1. Sign up free at <https://workers.cloudflare.com> (no card).
2. Dashboard → **Workers & Pages → Create → Create Worker**. Give it a name
   like `cwa-recap`. Click **Deploy** (the starter), then **Edit code**.
3. Delete the starter code, paste the contents of [`worker.js`](./worker.js),
   and click **Deploy**.

## 3. Add your key as a secret
In the Worker → **Settings → Variables and Secrets**:
- Add **Secret** `GEMINI_API_KEY` = your `AIza…` key. (Use "Encrypt".)
- (Optional) Add plain variable `GEMINI_MODEL` = `gemini-2.0-flash`
  (or `gemini-1.5-flash`) if you want a specific model.
- (Optional) Add `ALLOW_ORIGIN` if your app isn't on
  `https://alterrion-git.github.io`.
- **Deploy** again so the secret takes effect.

## 4. Point the app at it
Copy the Worker URL (e.g. `https://cwa-recap.<you>.workers.dev`) and paste it
into `index.html`:

```js
const LLM_PROXY_URL = 'https://cwa-recap.<you>.workers.dev';
```

Commit/deploy the app. AI recaps now work for every signed-in user with **no
API key needed** — gated to once per week / once per month as before.

## Test it
```bash
curl -X POST https://cwa-recap.<you>.workers.dev \
  -H 'Content-Type: application/json' \
  -H 'Origin: https://alterrion-git.github.io' \
  -d '{"system":"You are a coach.","prompt":"Say hello in one short sentence."}'
```
Expect `{"text":"..."}`.

## Notes / hardening (optional, later)
- The Worker only accepts requests whose `Origin` is your app — this stops
  casual browser abuse. Non-browser clients can spoof `Origin`, so if you go
  fully public, add a shared secret header or Cloudflare rate-limiting.
- Gemini's free tier is rate-limited per minute/day. Because recaps are gated
  weekly/monthly per user, normal usage stays well within it. If the quota is
  hit, recaps simply return an error until it resets — there is no bill.
- Swap models by changing `GEMINI_MODEL`; nothing in the app changes.
