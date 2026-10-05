import type { NextFunction, Request, Response } from 'express';
import { AlertSink } from './alerts';
import { challengePage, issueChallengeToken } from './challenge';
import { matchProfile } from './config';
import { applyDecisionHeaders, decisionFor } from './decision';
import { evaluateRequest } from './evaluate';
import { EventBus, postWebhook } from './events';
import { log } from './log';
import type { DefenseConfig, DefenseStore, EvaluationInput, IpReputationHook } from './types';
import { Telemetry } from './telemetry';

function readHeader(req: Request, name: string): string {
  const raw = req.headers[name];
  if (Array.isArray(raw)) return raw.join(',');
  return String(raw || '');
}

export function clientIp(req: Request, trustProxy: boolean): string {
  if (trustProxy) {
    const forwarded = readHeader(req, 'x-forwarded-for');
    if (forwarded) return forwarded.split(',')[0].trim();
    const cf = readHeader(req, 'cf-connecting-ip');
    if (cf) return cf;
  }
  return String(req.ip || req.socket.remoteAddress || 'unknown');
}

export function requestToInput(req: Request, trustProxy: boolean): EvaluationInput {
  return {
    method: req.method,
    path: req.path,
    headers: req.headers as EvaluationInput['headers'],
    body: req.body,
    ip: clientIp(req, trustProxy),
  };
}

export function createMiddleware(opts: {
  config: DefenseConfig;
  store: DefenseStore;
  telemetry: Telemetry;
  alerts: AlertSink;
  events?: EventBus;
  reputation?: IpReputationHook;
  webhookUrl?: string;
}) {
  const { config, store, telemetry, alerts } = opts;

  return async function botDefenseMiddleware(req: Request, res: Response, next: NextFunction): Promise<void> {
    if (req.path.startsWith('/__fcgbds/') || req.path.startsWith('/v1/') || req.path === '/health' || req.path === '/ready' || req.path === '/metrics' || req.path === '/dashboard' || req.path === '/wall.js') {
      next();
      return;
    }
    try {
      const input = requestToInput(req, config.trustProxy);
      const result = await evaluateRequest(input, config, store, { reputation: opts.reputation });
      telemetry.record(result);
      alerts.fromResult(req.path, result);
      const event = opts.events?.publish(req.path, input.ip, result);
      if (event && opts.webhookUrl) postWebhook(opts.webhookUrl, event);
      applyDecisionHeaders((name, value) => res.setHeader(name, value), result);
      if (result.action === 'allow') {
        next();
        return;
      }
      const token = result.action === 'challenge' ? issueChallengeToken(config.challengeSecret) : undefined;
      const decision = decisionFor(result, token);
      if (!decision) {
        next();
        return;
      }
      res.status(decision.status);
      const accept = String(req.headers.accept || '');
      if (decision.status === 429 && accept.includes('text/html')) {
        res.type('html').send(challengePage(token || ''));
        return;
      }
      res.json(decision.body);
    } catch (error) {
      const profile = matchProfile(req.path, req.method, config.profiles);
      log('error', 'middleware_failed', { message: error instanceof Error ? error.message : 'error', profile: profile.id });
      if (profile.failurePolicy === 'fail-closed') {
        res.status(503).json({ error: 'defense_unavailable', message: 'The evaluator failed and this route is fail-closed.' });
        return;
      }
      next();
    }
  };
}
