# FCGBC Legit Auth Worker + Synthetic Auth Broker

This package adds:

- API broker route: `POST /api/internal/synthetic-auth/lease`
- Worker: `fcgbc-legit-auth-worker`

The broker logs in synthetic `.fcgbc` identities through `POST /api/auth/wallet/login`, caches short-lived sessions, and returns reusable auth context to the worker.

## 1) API Environment Variables

Set these on the API service:

- `SYNTHETIC_BROKER_KEY` (required): shared secret used by worker -> broker calls.
- `SYNTHETIC_FCGBC_FILES_JSON` (required): JSON array of up to 10 `.fcgbc` payload blobs.
- `SYNTHETIC_FCGBC_MAX_POOL_SIZE` (optional, default `10`)
- `SYNTHETIC_AUTH_MIN_REUSE_SECONDS` (optional, default `60`)
- `SYNTHETIC_BROKER_API_BASE_URL` (optional, default `API_URL`)

### `SYNTHETIC_FCGBC_FILES_JSON` format

```json
[
  {
    "id": "synthetic-01",
    "label": "synthetic-legit-01",
    "fileData": "<full fcgbc file content as a single string>"
  },
  {
    "id": "synthetic-02",
    "label": "synthetic-legit-02",
    "fileData": "<full fcgbc file content as a single string>"
  }
]
```

## 1.5) Fetch 10 `.fcgbc` files from deployed API and build broker payload

Use the helper script:

```powershell
powershell.exe -ExecutionPolicy Bypass -File "C:\Users\rcnew\Desktop\PRODONLY\scripts\fetch-synthetic-fcgbc-files.ps1" `
  -ApiBase "https://PLACEHOLDER_API_BASE_URL" `
  -EndpointPath "/api/dev/synthetic-fcgbc/export" `
  -AuthHeaderName "x-dev-token" `
  -AuthHeaderValue "<YOUR_DEV_TOKEN>" `
  -Count 10 `
  -OutputDir "C:\Users\rcnew\Desktop\PRODONLY\cloudflare-workers\fcgbc-legit-auth-worker\test-wallets"
```

Output files:

- `cloudflare-workers/fcgbc-legit-auth-worker/test-wallets/*.fcgbc`
- `cloudflare-workers/fcgbc-legit-auth-worker/synthetic-fcgbc-files.json`
- `cloudflare-workers/fcgbc-legit-auth-worker/synthetic-fcgbc-files.env.txt`

Use `synthetic-fcgbc-files.env.txt` to set `SYNTHETIC_FCGBC_FILES_JSON` in API env.

## 2) Worker Secrets and Deploy

From `cloudflare-workers/fcgbc-legit-auth-worker`:

```powershell
wrangler secret put TRIGGER_KEY
wrangler secret put WAF_BYPASS_TOKEN
wrangler secret put BROKER_KEY
wrangler deploy
```

`BROKER_KEY` must match API `SYNTHETIC_BROKER_KEY`.

## 3) Warm Session Pool (10 identities)

```powershell
$body = @{
  triggerKey = "<TRIGGER_KEY>"
  count = 10
  forceRefresh = $false
} | ConvertTo-Json

Invoke-RestMethod -Method Post -Uri "https://fcgbc-legit-auth-worker.<your-subdomain>.workers.dev/bootstrap" -ContentType "application/json" -Body $body
```

## 4) Run Legit Auth Wave

```powershell
$body = @{
  triggerKey = "<TRIGGER_KEY>"
  trafficMode = "legit-auth"
} | ConvertTo-Json

Invoke-RestMethod -Method Post -Uri "https://fcgbc-legit-auth-worker.<your-subdomain>.workers.dev/run" -ContentType "application/json" -Body $body
```

## Notes

- Worker stores leases in memory and refreshes from broker when needed.
- Broker cache persists in Redis when configured.
- This does not bypass BDS; it provides realistic authenticated synthetic traffic.

