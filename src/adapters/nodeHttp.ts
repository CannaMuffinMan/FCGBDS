import http from 'http';
import { applyDecisionHeaders, decisionFor } from '../decision';
import { evaluateRequest, type EvaluateOptions } from '../evaluate';
import type { DefenseConfig, DefenseStore, EvaluationInput } from '../types';
import { Telemetry } from '../telemetry';

function headersOf(req: http.IncomingMessage): EvaluationInput['headers'] {
  return req.headers as EvaluationInput['headers'];
}

export function createNodeHttpMiddleware(opts: {
  config: DefenseConfig;
  store: DefenseStore;
  telemetry?: Telemetry;
  reputation?: EvaluateOptions['reputation'];
}) {
  const telemetry = opts.telemetry || new Telemetry();
  return async function fcgbds(req: http.IncomingMessage, res: http.ServerResponse, next: () => void): Promise<void> {
    const host = String(req.headers.host || '');
    const path = (req.url || '/').split('?')[0];
    const input: EvaluationInput = {
      method: req.method || 'GET',
      path,
      headers: { ...headersOf(req), host },
      body: undefined,
      ip: req.socket.remoteAddress || 'unknown',
    };
    const result = await evaluateRequest(input, opts.config, opts.store, { reputation: opts.reputation });
    telemetry.record(result);
    applyDecisionHeaders((name, value) => res.setHeader(name, value), result);
    const decision = decisionFor(result);
    if (!decision) {
      next();
      return;
    }
    res.statusCode = decision.status;
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify(decision.body));
  };
}
