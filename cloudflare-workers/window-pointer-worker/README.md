# Window Pointer Worker

Minimal Cloudflare Worker that only points a browser window to preconfigured URLs.

## Behavior

- `GET /` sends the window to `DEFAULT_POINTER_URL` or the `default` alias in `POINTER_URLS`
- `GET /go/<alias>` sends the window to that alias target
- `GET /?target=<alias>` does the same using a query param
- `GET /healthz` returns a small JSON health response

This worker does not allow arbitrary redirect URLs. It only uses destinations defined in `POINTER_URLS` and enforces `ALLOWED_TARGET_HOSTS`.

## Configure

Edit [wrangler.toml](c:/Users/rcnew/Desktop/PRODONLY/cloudflare-workers/window-pointer-worker/wrangler.toml):

- `DEFAULT_POINTER_URL`
- `ALLOWED_TARGET_HOSTS`
- `POINTER_URLS`
- `REDIRECT_MODE`

Example alias map:

```toml
POINTER_URLS = '{"default":"https://PLACEHOLDER_WEB_ORIGIN","app":"https://PLACEHOLDER_APP_ORIGIN","discord":"https://discord.gg/yourinvite"}'
```

## Deploy

From this folder:

```powershell
wrangler deploy
```

## Example URLs

- `/`
- `/go/app`
- `/go/discord`
- `/?target=app`

## Notes

- `REDIRECT_MODE = "window"` returns an HTML page that runs `window.location.replace(...)`
- `REDIRECT_MODE = "http"` returns a normal HTTP 302 redirect instead

