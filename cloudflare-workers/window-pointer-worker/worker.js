function json(data, status = 200) {
  return new Response(JSON.stringify(data, null, 2), {
    status,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
    },
  });
}

function html(body, status = 200) {
  return new Response(body, {
    status,
    headers: {
      'content-type': 'text/html; charset=utf-8',
      'cache-control': 'no-store',
    },
  });
}

function escapeHtml(value) {
  return String(value || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function parseAliasMap(env) {
  const raw = String(env.POINTER_URLS || '').trim();
  if (!raw) return {};

  try {
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};

    const clean = {};
    for (const [key, value] of Object.entries(parsed)) {
      const alias = String(key || '').trim().toLowerCase();
      const url = String(value || '').trim();
      if (alias && url) clean[alias] = url;
    }
    return clean;
  } catch {
    return {};
  }
}

function getDestination(url, env) {
  const aliasMap = parseAliasMap(env);
  const aliasFromQuery = String(url.searchParams.get('target') || url.searchParams.get('alias') || '').trim().toLowerCase();
  const pathParts = url.pathname.replace(/^\/+|\/+$/g, '').split('/').filter(Boolean);
  const aliasFromPath = pathParts[0] === 'go' && pathParts[1]
    ? String(pathParts[1]).trim().toLowerCase()
    : (pathParts[0] ? String(pathParts[0]).trim().toLowerCase() : '');

  const alias = aliasFromQuery || aliasFromPath || 'default';
  const target = aliasMap[alias] || (alias === 'default' ? String(env.DEFAULT_POINTER_URL || '').trim() : '');
  return { alias, target };
}

function isAllowedDestination(target, env) {
  if (!target) return false;

  try {
    const parsed = new URL(target);
    if (!['http:', 'https:'].includes(parsed.protocol)) return false;

    const allowedHosts = String(env.ALLOWED_TARGET_HOSTS || '')
      .split(',')
      .map((value) => value.trim().toLowerCase())
      .filter(Boolean);

    if (allowedHosts.length === 0) return true;
    return allowedHosts.includes(parsed.hostname.toLowerCase());
  } catch {
    return false;
  }
}

function buildLandingPage(target, alias) {
  const safeTarget = escapeHtml(target);
  const safeAlias = escapeHtml(alias);

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>Redirecting...</title>
  <meta http-equiv="refresh" content="0; url=${safeTarget}" />
  <style>
    :root {
      color-scheme: dark;
      --bg: #07111b;
      --panel: #0c1b29;
      --line: #163349;
      --text: #e7f5ff;
      --muted: #8fb3c8;
      --accent: #34f3e2;
    }
    * { box-sizing: border-box; }
    body {
      margin: 0;
      min-height: 100vh;
      display: grid;
      place-items: center;
      padding: 24px;
      background: radial-gradient(circle at top, #10304a 0%, var(--bg) 55%);
      color: var(--text);
      font-family: "Segoe UI", system-ui, sans-serif;
    }
    .card {
      width: min(680px, 100%);
      padding: 28px;
      border: 1px solid var(--line);
      border-radius: 18px;
      background: rgba(12, 27, 41, 0.95);
      box-shadow: 0 24px 60px rgba(0, 0, 0, 0.35);
    }
    h1 {
      margin: 0 0 10px;
      font-size: 1.4rem;
    }
    p {
      margin: 0 0 10px;
      color: var(--muted);
      line-height: 1.5;
    }
    a {
      color: var(--accent);
      word-break: break-word;
    }
    code {
      color: var(--text);
    }
  </style>
</head>
<body>
  <main class="card">
    <h1>Redirecting window</h1>
    <p>Alias: <code>${safeAlias}</code></p>
    <p>If the browser does not move automatically, open <a href="${safeTarget}" rel="noreferrer">${safeTarget}</a>.</p>
  </main>
  <script>
    window.location.replace(${JSON.stringify(target)});
  </script>
</body>
</html>`;
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (url.pathname === '/healthz') {
      return json({ ok: true, worker: 'window-pointer-worker' });
    }

    if (!['GET', 'HEAD'].includes(request.method)) {
      return json({ ok: false, error: 'method_not_allowed' }, 405);
    }

    const { alias, target } = getDestination(url, env);

    if (!target) {
      return json({
        ok: false,
        error: 'unknown_target',
        alias,
        hint: 'Set DEFAULT_POINTER_URL or add the alias to POINTER_URLS.',
      }, 404);
    }

    if (!isAllowedDestination(target, env)) {
      return json({
        ok: false,
        error: 'target_not_allowed',
        alias,
      }, 400);
    }

    if (String(env.REDIRECT_MODE || 'window').trim().toLowerCase() === 'http') {
      return Response.redirect(target, 302);
    }

    if (request.method === 'HEAD') {
      return new Response(null, {
        status: 204,
        headers: {
          'x-pointer-alias': alias,
          'x-pointer-target': target,
        },
      });
    }

    return html(buildLandingPage(target, alias));
  },
};