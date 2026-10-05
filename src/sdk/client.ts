export interface EvaluateRequest {
  method: string;
  path: string;
  ip: string;
  headers?: Record<string, string>;
  body?: unknown;
  trafficLane?: 'live' | 'practice';
}

export interface EvaluateResponse {
  result: {
    action: 'allow' | 'challenge' | 'block';
    score: number;
    mode: string;
    enforced: boolean;
    wouldHaveBlocked: boolean;
    wouldHaveChallenged: boolean;
    profileId: string;
    signals: Array<{ id: string; score: number; triggered: boolean; detail?: string }>;
  };
  response: null | {
    error: string;
    message: string;
    httpStatus: number;
    decision: string;
    score: number;
    signals: string[];
    token?: string;
  };
}

export class FcgbdsClient {
  constructor(
    private baseUrl: string,
    private apiToken = '',
    private fetchImpl: typeof fetch = fetch,
  ) {}

  private async send(path: string, init: { method?: string; body?: unknown } = {}): Promise<Response> {
    const headers: Record<string, string> = {};
    if (init.body !== undefined) headers['content-type'] = 'application/json';
    if (this.apiToken) headers.authorization = `Bearer ${this.apiToken}`;
    return this.fetchImpl(`${this.baseUrl.replace(/\/$/, '')}${path}`, {
      method: init.method || 'GET',
      headers,
      body: init.body === undefined ? undefined : JSON.stringify(init.body),
    });
  }

  async evaluate(input: EvaluateRequest): Promise<EvaluateResponse> {
    const res = await this.send('/v1/evaluate', { method: 'POST', body: input });
    if (!res.ok) {
      const text = await res.text();
      throw new Error(`FCGBDS evaluate failed (${res.status}): ${text}`);
    }
    return (await res.json()) as EvaluateResponse;
  }

  async health(): Promise<{ ok: boolean; mode: string; store: string; version: string }> {
    const res = await this.send('/health');
    if (!res.ok) throw new Error(`health ${res.status}`);
    return (await res.json()) as { ok: boolean; mode: string; store: string; version: string };
  }
}
