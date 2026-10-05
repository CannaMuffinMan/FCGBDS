/**
 * Cloudflare Worker that asks the operator's FCGBDS instance before continuing.
 * Bind FCGBDS_URL and optional FCGBDS_API_TOKEN in the Worker's environment.
 * This file does not call any Forever Couch Gang host.
 */
export default {
  async fetch(request, env) {
    const base = String(env.FCGBDS_URL || '').replace(/\/$/, '');
    if (!base) {
      return new Response(JSON.stringify({ error: 'fcgbds_unconfigured', message: 'Set FCGBDS_URL to your instance.' }), {
        status: 503,
        headers: { 'content-type': 'application/json' },
      });
    }
    const url = new URL(request.url);
    const evaluate = await fetch(`${base}/v1/evaluate`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...(env.FCGBDS_API_TOKEN ? { authorization: `Bearer ${env.FCGBDS_API_TOKEN}` } : {}),
      },
      body: JSON.stringify({
        method: request.method,
        path: url.pathname,
        ip: request.headers.get('cf-connecting-ip') || 'unknown',
        headers: Object.fromEntries(request.headers),
      }),
    });
    const body = await evaluate.json();
    if (!evaluate.ok) {
      return new Response(JSON.stringify({ error: 'defense_unavailable', message: 'FCGBDS evaluate failed.' }), {
        status: 503,
        headers: { 'content-type': 'application/json' },
      });
    }
    if (!body.response) {
      return new Response(JSON.stringify({ ok: true, decision: 'allow', score: body.result?.score ?? 0 }), {
        status: 200,
        headers: { 'content-type': 'application/json', 'x-fcgbds-decision': 'allow' },
      });
    }
    return new Response(JSON.stringify(body.response), {
      status: body.response.httpStatus,
      headers: {
        'content-type': 'application/json',
        'x-fcgbds-decision': String(body.response.decision),
        'x-fcgbds-score': String(body.response.score),
      },
    });
  },
};
