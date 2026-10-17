# CWA AI proxy (Cloudflare Worker + Workers AI)

This tiny Worker runs the AI Coach model and the food-photo reader **on
Cloudflare (Workers AI)**. There is **no external API key** and **no regional
free-tier limits** (Google's Gemini free tier is unavailable / `limit: 0` in
some regions like the EU — this avoids that).

- AI Coach: the app sends `{ system, messages | prompt, user, maxTokens }` and gets `{ text }`.
- Food photos (Food tab → Photo): the app sends `{ task: "food-photo", image, user }`
  (a JPEG data URL of a nutrition label, a product or a plate) and gets
  `{ food: { name, brand, barcode, per100: { kcal, protein, carbs, sugar, fat, fibre, salt }, ... } }`.

> **Updating from an older version:** paste the new [`worker.js`](./worker.js)
> over the old code and **Deploy**. Nothing else changes (same URL, same `AI`
> binding). Until you do, everything else works; only food photos fail.

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
- Plain variable `AI_MODEL` to put another chat model first. Without it the
  Worker uses `@cf/openai/gpt-oss-120b` (OpenAI's open-weight reasoning model)
  and falls back to `@cf/meta/llama-3.3-70b-instruct-fp8-fast` if that model
  is unavailable or returns nothing. The app shows which model answered under
  the chat box.
- Food photos are read in two steps, because gpt-oss can't see images:
  1. A vision model writes down what it sees (the nutrition table copied as
     printed, or the plate's items with estimated grams). It tries
     `@cf/google/gemma-4-26b-a4b-it`, then
     `@cf/meta/llama-4-scout-17b-16e-instruct`,
     `@cf/mistralai/mistral-small-3.1-24b-instruct`, `@cf/google/gemma-3-12b-it`
     and finally `@cf/meta/llama-3.2-11b-vision-instruct`, using the first that
     answers. Plain variable `VISION_MODEL` puts another one first.
  2. `@cf/openai/gpt-oss-120b` works out the nutrition values from those notes
     (unit conversions, sanity checks, meal estimates). Plain variable
     `NUTRITION_MODEL` swaps it. If this step fails, the vision model's own
     numbers are used.
  The app shows "Read by …" with both models under the photo result. If photos
  fail, the error message lists why each model failed.
- Plain variable `ALLOW_ORIGIN` if the app isn't on
  `https://alterrion-git.github.io`.

## 3. Point the app at it
Copy the Worker URL (e.g. `https://cwa-recap.<you>.workers.dev`) into
`index.html`:

```js
const LLM_PROXY_URL = 'https://cwa-recap.<you>.workers.dev';
```

Then in the app: **Profile → Settings → AI Coach → Test connection** should say
"AI service works ✓".

## Test from a terminal (optional)
```bash
curl -X POST https://cwa-recap.<you>.workers.dev \
  -H 'Content-Type: application/json' \
  -H 'Origin: https://alterrion-git.github.io' \
  -d '{"system":"You are a coach.","prompt":"Say hi in one sentence."}'
```
Expect `{"text":"..."}`.

## Optional: server-side daily limit (recommended for public use)
The app already caps each user to 5 AI messages/day, but that's client-side.
To enforce it on the server (so nobody can bypass it and drain the free
allocation):
1. Cloudflare → **Storage & Databases → KV → Create namespace** (e.g. `cwa-rl`).
2. Worker → **Settings → Bindings → Add → KV namespace** → variable name **`RL`**
   → pick that namespace → **Deploy**.
3. (Optional) plain variables `DAILY_LIMIT` (chat, defaults to `10`) and
   `VISION_DAILY_LIMIT` (food photos, defaults to `30`).

With `RL` bound, the Worker counts requests per user per day and returns 429
past the limit. Without it, only the app's client-side limit applies.

## Notes
- The Worker only accepts requests whose `Origin` is your app (stops casual
  browser abuse). For a fully public release, also add the KV limit above.
- Swap models any time via `AI_MODEL`; the app never changes.
- The app sends `{ system, messages: [...], user, maxTokens }` for chat,
  `{ system, prompt }` for the Settings "Test connection" ping, and
  `{ task: "food-photo", image, user }` for food photos.
- Food photos are sent to the Worker only when you use **Photo** in the Food
  tab. Progress photos never leave the device.
- Open Food Facts fallback: when OFF doesn't answer the browser (its legacy
  search often returns 503), the app asks the Worker instead:
  `{ task: "off-search", q }` and `{ task: "off-product", code }`. The Worker
  calls OFF server side with an app User-Agent (Search-a-licious first, the
  legacy search second) and caches answers for a day. No binding or variable
  is needed — just deploy the current `worker.js`. An older Worker answers
  these with "Empty prompt" and the app falls back to OFF directly.
