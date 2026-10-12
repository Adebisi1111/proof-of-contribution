# Deploying the relay backend

The frontend cannot sign a GenLayer write directly — a GenLayer write is a
rollup transaction that must be signed by a key the client holds, and an
injected browser wallet cannot produce that signature. The relay backend holds
the signer key and sends the transaction.

## 1. Deploy to Render

1. Push this repo to GitHub.
2. On [render.com](https://render.com) → New → Blueprint → select the repo.
   `render.yaml` configures the service automatically.
3. Set `DEPLOY_PK` in the Render dashboard (Environment → Secret File or env
   var) to the private key of the account that will sign reviews. It is never
   committed and never reaches the browser.

Render gives you a URL like `https://proof-of-contribution-relay.onrender.com`.

## 2. Point the frontend at the relay

In `public/index.html` the relay URL defaults to that Render hostname. If your
deployment differs, set it before the module loads:

```html
<script>window.__RELAY_URL__ = 'https://your-relay.onrender.com';</script>
<script src="./rpc-fix.js"></script>
```

## 3. Verify

```bash
curl https://your-relay.onrender.com/api/health
# {"ok":true,"contract":"0x218E...","codeBytes":9944,"signer":"0x61fd..."}

curl -X POST https://your-relay.onrender.com/api/review \
  -H "Content-Type: application/json" \
  -d '{"review_id":"t1","artifact_url":"https://example.com/doc.md",
       "rubric":"Rate depth, clarity, and quality from 1 to 5."}'
# {"resultName":"AGREE","exec":"FINISHED_WITH_RETURN","committed":true,
#  "review":{"rating":3,...}}
```

## Local run

```bash
cd server && DEPLOY_PK=0x<key> PORT=3000 node index.js
```

## Endpoints

| Method | Path | Purpose |
|---|---|---|
| GET | `/api/health` | contract reachable, code stored, signer address |
| GET | `/api/stats` | total developers / reviews |
| GET | `/api/reputation/:addr` | one developer's profile |
| POST | `/api/review` | sign and submit a review, wait for consensus, read back the result |

The relay validates `review_id` (bounded charset) and `artifact_url`
(http/https only), and rejects rubrics over 500 characters.

## Security note

`DEPLOY_PK` is a live Bradbury key. Anyone who can POST to `/api/review` can
spend that account's GEN on consensus fees. Put rate limiting and an allowlist
in front of it before making it public — the `free` Render plan also sleeps, so
the first request after idle may take ~30s to cold-start.
