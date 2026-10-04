import type { NextFunction, Request, Response } from 'express';
import { evaluateRequest } from './evaluate';
import { challengePage, issueChallengeToken } from './challenge';
import { AlertSink } from './alerts';
import { Telemetry } from './telemetry';
import type { DefenseConfig, DefenseStore, EvaluationInput } from './types';

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
}) {
  const { config, store, telemetry, alerts } = opts;

  return async function botDefenseMiddleware(req: Request, res: Response, next: NextFunction): Promise<void> {
    if (req.path.startsWith('/__fcgbds/')) {
      next();
      return;
    }
    try {
      const result = await evaluateRequest(requestToInput(req, config.trustProxy), config, store);
      telemetry.record(result);
      alerts.fromResult(req.path, result);
      res.setHeader('X-FCGBDS-Mode', result.mode);
      res.setHeader('X-FCGBDS-Score', String(result.score));
      res.setHeader('X-FCGBDS-Would-Block', result.wouldHaveBlocked ? '1' : '0');
      res.setHeader('X-FCGBDS-Would-Challenge', result.wouldHaveChallenged ? '1' : '0');
      if (result.allowlisted || result.action === 'allow') {
        next();
        return;
      }
      if (result.action === 'challenge') {
        const token = issueChallengeToken(config.challengeSecret);
        const accept = String(req.headers.accept || '');
        res.status(429);
        if (accept.includes('text/html')) {
          res.type('html').send(challengePage(token));
        } else {
          res.json({
            error: 'challenge_required',
            score: result.score,
            signals: result.signals.filter((s) => s.triggered).map((s) => s.id),
          });
        }
        return;
      }
      res.status(403).json({
        error: 'request_blocked',
        score: result.score,
        signals: result.signals.filter((s) => s.triggered).map((s) => s.id),
      });
    } catch {
      const policy = config.profiles[0]?.failurePolicy || 'fail-open';
      if (policy === 'fail-closed') {
        res.status(503).json({ error: 'defense_unavailable' });
        return;
      }
      next();
    }
  };
}
