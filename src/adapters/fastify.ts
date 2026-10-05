import { applyDecisionHeaders, decisionFor } from '../decision';
import { evaluateRequest } from '../evaluate';
import type { DefenseConfig, DefenseStore, EvaluationInput } from '../types';
import { Telemetry } from '../telemetry';

interface FastifyLike {
  addHook(name: 'onRequest', handler: (req: FastifyRequestLike, reply: FastifyReplyLike) => Promise<void>): void;
}

interface FastifyRequestLike {
  method: string;
  url: string;
  headers: Record<string, string | string[] | undefined>;
  ip: string;
  body?: unknown;
}

interface FastifyReplyLike {
  header(name: string, value: string): void;
  code(status: number): FastifyReplyLike;
  send(body: unknown): void;
}

export function fcgbdsFastifyPlugin(opts: { config: DefenseConfig; store: DefenseStore; telemetry?: Telemetry }) {
  const telemetry = opts.telemetry || new Telemetry();
  return function plugin(fastify: FastifyLike, _options: unknown, done: (error?: Error) => void): void {
    fastify.addHook('onRequest', async (req, reply) => {
      const path = req.url.split('?')[0];
      if (path.startsWith('/__fcgbds')) return;
      const input: EvaluationInput = {
        method: req.method,
        path,
        headers: req.headers,
        body: req.body,
        ip: req.ip || 'unknown',
      };
      const result = await evaluateRequest(input, opts.config, opts.store);
      telemetry.record(result);
      applyDecisionHeaders((name, value) => reply.header(name, value), result);
      const decision = decisionFor(result);
      if (!decision) return;
      reply.code(decision.status).send(decision.body);
    });
    done();
  };
}
