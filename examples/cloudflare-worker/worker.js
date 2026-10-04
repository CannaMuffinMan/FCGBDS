/**
 * Edge subset of FCGBDS: host check, automation UA, honeypot JSON fields.
 * No Redis. Observe by default. Not equivalent to the Node core.
 */

const AUTOMATION = [
  'headlesschrome',
  'puppeteer',
  'playwright',
  'python-requests',
  'curl/',
  'wget/',
  'go-http-client',
];

function scoreRequest(request, env, body) {
  let score = 0;
  const ua = (request.headers.get('user-agent') || '').toLowerCase();
  const expected = String(env.EXPECTED_HOSTNAME || '').toLowerCase();
  const host = (request.headers.get('host') || '').toLowerCase().split(':')[0];
  if (expected && host && host !== expected) score += 40;
  if (!ua) score += 30;
  if (AUTOMATION.some((h) => ua.includes(h))) score += 35;
  const fields = String(env.HONEYPOT_FIELDS || 'website,homepage').split(',');
  if (body && typeof body === 'object') {
    for (const field of fields) {
      const value = body[field.trim()];
      if (typeof value === 'string' && value.trim()) score += 90;
    }
  }
  return Math.min(100, score);
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname === '/health') {
      return Response.json({ ok: true, mode: env.FCGBDS_MODE || 'observe' });
    }
    let body = null;
    if (request.headers.get('content-type')?.includes('application/json')) {
      try {
        body = await request.clone().json();
      } catch {
        body = null;
      }
    }
    const score = scoreRequest(request, env, body);
    const mode = env.FCGBDS_MODE === 'enforce' ? 'enforce' : 'observe';
    const blockAt = Number(env.BLOCK_THRESHOLD || 90);
    const wouldBlock = score >= blockAt;
    const headers = {
      'X-FCGBDS-Score': String(score),
      'X-FCGBDS-Would-Block': wouldBlock ? '1' : '0',
      'X-FCGBDS-Mode': mode,
    };
    if (mode === 'enforce' && wouldBlock) {
      return Response.json({ error: 'request_blocked', score }, { status: 403, headers });
    }
    const origin = env.ORIGIN_URL;
    if (!origin) {
      return Response.json({ ok: true, score, observed: true }, { headers });
    }
    const upstream = await fetch(new URL(url.pathname + url.search, origin), request);
    const response = new Response(upstream.body, upstream);
    for (const [k, v] of Object.entries(headers)) response.headers.set(k, v);
    return response;
  },
};
