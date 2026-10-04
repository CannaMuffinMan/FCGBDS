# Cloudflare Worker example

Deploy a header/honeypot subset at the edge:

```bash
cd examples/cloudflare-worker
npx wrangler deploy
```

Set `ORIGIN_URL` to your API if you want the worker to proxy. Leave it empty to return JSON only.

This worker does not implement Redis, challenges, or the full signal set.
