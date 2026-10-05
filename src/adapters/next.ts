export interface RemoteDecision {
  result: {
    action: 'allow' | 'challenge' | 'block';
    score: number;
    mode: string;
    wouldHaveBlocked: boolean;
    wouldHaveChallenged: boolean;
    profileId: string;
    signals: Array<{ id: string; triggered: boolean }>;
  };
  response: null | {
    httpStatus: number;
    error: string;
    message: string;
    decision: string;
    score: number;
    signals: string[];
  };
}

export interface NextGuardOptions {
  /** Base URL of the operator's FCGBDS instance, with no trailing path. */
  baseUrl: string;
  apiToken?: string;
  fetchImpl?: typeof fetch;
}

function headerMap(headers: Headers): Record<string, string> {
  const out: Record<string, string> = {};
  headers.forEach((value, key) => {
    out[key] = value;
  });
  return out;
}

/**
 * Call from Next.js middleware or a route handler. Returns a Response to send,
 * or null when the request should continue.
 */
export async function guardNextRequest(request: Request, opts: NextGuardOptions): Promise<Response | null> {
  const fetchImpl = opts.fetchImpl || fetch;
  const url = new URL(request.url);
  const response = await fetchImpl(`${opts.baseUrl.replace(/\/$/, '')}/v1/evaluate`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...(opts.apiToken ? { authorization: `Bearer ${opts.apiToken}` } : {}),
    },
    body: JSON.stringify({
      method: request.method,
      path: url.pathname,
      ip: request.headers.get('x-forwarded-for')?.split(',')[0].trim() || 'unknown',
      headers: headerMap(request.headers),
    }),
  });
  if (!response.ok && response.status !== 200) {
    return new Response(JSON.stringify({ error: 'defense_unavailable', message: 'FCGBDS evaluate failed.' }), {
      status: 503,
      headers: { 'content-type': 'application/json' },
    });
  }
  const body = (await response.json()) as RemoteDecision;
  if (!body.response) return null;
  return new Response(JSON.stringify(body.response), {
    status: body.response.httpStatus,
    headers: {
      'content-type': 'application/json',
      'x-fcgbds-decision': body.response.decision,
      'x-fcgbds-score': String(body.response.score),
    },
  });
}
