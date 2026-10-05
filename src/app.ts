import express, { type NextFunction, type Request, type Response } from 'express';
import helmet from 'helmet';
import { randomUUID } from 'crypto';
import { AlertSink } from './alerts';
import { bearer, readCookie, sessionValid, signSession, tokensEqual } from './auth';
import { challengePage, challengePassed, issueChallengeToken, issueClearance } from './challenge';
import { matchProfile } from './config';
import { dashboardPage, wallScript } from './dashboardPage';
import { applyDecisionHeaders, decisionFor } from './decision';
import { evaluateRequest } from './evaluate';
import { findTenant, newAppKey, readTenants, writeTenants, hashAppKey } from './tenants';
import { EventBus, postWebhook } from './events';
import { isListKind, isMatchType } from './lists';
import { log } from './log';
import { prometheusText } from './metrics';
import { createMiddleware } from './middleware';
import type { DefenseConfig, DefenseStore, EvaluationInput, IpReputationHook, RouteProfile } from './types';
import { Telemetry } from './telemetry';

export interface AppOptions {
  config: DefenseConfig;
  store: DefenseStore;
  telemetry: Telemetry;
  alerts: AlertSink;
  events: EventBus;
  reputation?: IpReputationHook;
  apiToken: string;
  dashboardPassword: string;
  sessionSecret: string;
  wallPublic: boolean;
  webhookUrl?: string;
  version: string;
  redisConfigured: boolean;
}

function header(req: Request, name: string): string {
  const raw = req.headers[name];
  if (Array.isArray(raw)) return raw.join(',');
  return String(raw || '');
}

function inputFrom(req: Request, config: DefenseConfig, path: string, method: string): EvaluationInput {
  const forwarded = header(req, 'x-forwarded-for');
  const ip = config.trustProxy && forwarded ? forwarded.split(',')[0].trim() : String(req.ip || req.socket.remoteAddress || 'unknown');
  return {
    method,
    path,
    headers: req.headers as EvaluationInput['headers'],
    body: req.body,
    ip: ip || 'unknown',
  };
}

function adminOk(req: Request, opts: AppOptions): boolean {
  if (opts.apiToken && tokensEqual(bearer(header(req, 'authorization')), opts.apiToken)) return true;
  if (opts.dashboardPassword && sessionValid(opts.sessionSecret, readCookie(header(req, 'cookie'), 'fcgbds_session'))) {
    return true;
  }
  return false;
}

function requireAdmin(req: Request, res: Response, opts: AppOptions): boolean {
  if (adminOk(req, opts)) return true;
  res.status(401).json({
    error: 'unauthorized',
    message: 'Send Authorization: Bearer <FCGBDS_API_TOKEN> or sign in to the dashboard.',
  });
  return false;
}

export function createApp(opts: AppOptions): express.Express {
  const app = express();
  app.disable('x-powered-by');
  app.use(helmet({ contentSecurityPolicy: false }));
  app.use(express.json({ limit: '1mb' }));
  app.use(express.urlencoded({ extended: false }));

  app.get('/health', (_req, res) => {
    res.json({ ok: true, mode: opts.config.mode, store: opts.store.backend(), version: opts.version });
  });

  app.get('/ready', (_req, res) => {
    const degraded = opts.redisConfigured && opts.store.backend() === 'memory';
    const body = { ok: !degraded, degraded, store: opts.store.backend(), mode: opts.config.mode };
    res.status(degraded ? 503 : 200).json(body);
  });

  app.get('/metrics', (_req, res) => {
    res.type('text/plain; version=0.0.4').send(prometheusText(opts.telemetry, opts.config.mode, opts.store.backend()));
  });

  app.get('/v1/wall', (_req, res) => {
    if (!opts.wallPublic) {
      res.status(404).json({ error: 'wall_disabled', message: 'Set FCGBDS_WALL_PUBLIC=true to expose aggregate counts.' });
      return;
    }
    const checks = opts.telemetry.checksSnapshot();
    res.json({
      checksIssued: checks.checksIssued,
      passed: checks.passed,
      notVerified: checks.notVerified,
      stopped: checks.stopped,
      mode: opts.config.mode,
    });
  });

  app.get('/wall.js', (_req, res) => {
    res.type('application/javascript').send(wallScript());
  });

  app.get('/dashboard', (_req, res) => {
    if (!opts.dashboardPassword) {
      res.status(404).json({ error: 'dashboard_disabled', message: 'Set FCGBDS_DASHBOARD_PASSWORD to enable the dashboard.' });
      return;
    }
    res.type('html').send(dashboardPage());
  });

  app.post('/v1/session', (req, res) => {
    if (!opts.dashboardPassword || !tokensEqual(String(req.body?.password || ''), opts.dashboardPassword)) {
      res.status(401).json({ error: 'unauthorized', message: 'Dashboard password did not match.' });
      return;
    }
    const token = signSession(opts.sessionSecret);
    res.setHeader('Set-Cookie', `fcgbds_session=${token}; HttpOnly; SameSite=Lax; Path=/`);
    res.json({ ok: true });
  });

  app.get('/v1/stats', (req, res) => {
    if (!requireAdmin(req, res, opts)) return;
    const checks = opts.telemetry.checksSnapshot();
    res.json({
      mode: opts.config.mode,
      store: opts.store.backend(),
      checksIssued: checks.checksIssued,
      passed: checks.passed,
      notVerified: checks.notVerified,
      stopped: checks.stopped,
      telemetry: opts.telemetry.snapshot(),
      recentAlerts: opts.alerts.recent().slice(-50),
      apps: opts.telemetry.apps(),
    });
  });

  app.get('/v1/apps', async (req, res) => {
    if (!requireAdmin(req, res, opts)) return;
    const apps = await readTenants(opts.store);
    res.json({
      apps: apps.map((app) => ({ id: app.id, name: app.name, mode: app.mode || opts.config.mode, webhook: Boolean(app.webhookUrl) })),
    });
  });

  app.post('/v1/apps', async (req, res) => {
    if (!requireAdmin(req, res, opts)) return;
    const id = String(req.body?.id || '').trim();
    const name = String(req.body?.name || id).trim();
    if (!/^[a-z0-9][a-z0-9_-]{0,63}$/i.test(id)) {
      res.status(400).json({ error: 'invalid_app', message: 'id must be 1–64 letters, numbers, _ or -.' });
      return;
    }
    const apps = await readTenants(opts.store);
    if (apps.some((app) => app.id === id)) {
      res.status(409).json({ error: 'app_exists', message: 'An app with that id already exists. Keys are not shown again.' });
      return;
    }
    const apiKey = newAppKey();
    apps.push({
      id,
      name,
      keyHash: hashAppKey(apiKey),
      mode: req.body?.mode === 'enforce' || req.body?.mode === 'observe' ? req.body.mode : undefined,
      profiles: Array.isArray(req.body?.profiles) ? req.body.profiles : undefined,
      webhookUrl: req.body?.webhookUrl ? String(req.body.webhookUrl) : undefined,
    });
    await writeTenants(opts.store, apps);
    res.status(201).json({
      app: { id, name },
      apiKey,
      message: 'Store this key. It is not shown again. Send it as Authorization: Bearer on POST /v1/evaluate.',
    });
  });

  app.post('/v1/mode', async (req, res) => {
    if (!requireAdmin(req, res, opts)) return;
    const mode = req.body?.mode === 'enforce' ? 'enforce' : req.body?.mode === 'observe' ? 'observe' : '';
    if (!mode) {
      res.status(400).json({ error: 'invalid_mode', message: 'mode must be observe or enforce.' });
      return;
    }
    opts.config.mode = mode;
    await opts.store.setMeta('mode', mode);
    log('info', 'mode_changed', { mode });
    res.json({ ok: true, mode });
  });

  app.get('/v1/policies', (req, res) => {
    if (!requireAdmin(req, res, opts)) return;
    res.json({
      mode: opts.config.mode,
      challengeThreshold: opts.config.challengeThreshold,
      blockThreshold: opts.config.blockThreshold,
      profiles: opts.config.profiles,
    });
  });

  app.put('/v1/policies', async (req, res) => {
    if (!requireAdmin(req, res, opts)) return;
    const profiles = req.body?.profiles;
    if (!Array.isArray(profiles) || profiles.some((p) => !p || typeof p.id !== 'string' || !Array.isArray(p.pathPrefixes))) {
      res.status(400).json({ error: 'invalid_policies', message: 'profiles must be an array of route profiles.' });
      return;
    }
    opts.config.profiles = profiles as RouteProfile[];
    await opts.store.setMeta('profiles', JSON.stringify(profiles));
    res.json({ ok: true, profiles: opts.config.profiles });
  });

  app.get('/v1/lists/:kind', async (req, res) => {
    if (!requireAdmin(req, res, opts)) return;
    if (!isListKind(req.params.kind)) {
      res.status(404).json({ error: 'unknown_list' });
      return;
    }
    res.json({ entries: await opts.store.list(req.params.kind) });
  });

  app.post('/v1/lists/:kind', async (req, res) => {
    if (!requireAdmin(req, res, opts)) return;
    if (!isListKind(req.params.kind)) {
      res.status(404).json({ error: 'unknown_list' });
      return;
    }
    const matchType = String(req.body?.matchType || '');
    const value = String(req.body?.value || '').trim();
    if (!isMatchType(matchType) || !value) {
      res.status(400).json({ error: 'invalid_entry', message: 'matchType must be ip, cidr, ua, path, or header, and value is required. header values look like x-api-key:prefix.' });
      return;
    }
    const entry = {
      id: String(req.body?.id || randomUUID()),
      kind: req.params.kind,
      matchType,
      value,
      note: req.body?.note ? String(req.body.note) : undefined,
    };
    await opts.store.putList(entry);
    res.status(201).json({ entry });
  });

  app.delete('/v1/lists/:kind/:id', async (req, res) => {
    if (!requireAdmin(req, res, opts)) return;
    if (!isListKind(req.params.kind)) {
      res.status(404).json({ error: 'unknown_list' });
      return;
    }
    const removed = await opts.store.deleteList(req.params.kind, req.params.id);
    res.json({ removed });
  });

  app.post('/v1/evaluate', async (req, res) => {
    const presented = bearer(header(req, 'authorization'));
    const tenants = await readTenants(opts.store);
    const tenant = await findTenant(opts.store, presented);
    const admin = Boolean(opts.apiToken) && tokensEqual(presented, opts.apiToken);
    if (tenants.length > 0 && !tenant && !admin) {
      res.status(401).json({
        error: 'unauthorized',
        message: 'Send the app key for the API you are protecting, or the admin token.',
      });
      return;
    }
    if (tenants.length === 0 && opts.apiToken && !admin) {
      res.status(401).json({ error: 'unauthorized', message: 'FCGBDS_API_TOKEN is set. Send it as a bearer token.' });
      return;
    }
    const body = req.body || {};
    const named = tenant || (admin && body.appId ? tenants.find((app) => app.id === String(body.appId)) : undefined);
    const input: EvaluationInput = {
      method: String(body.method || 'GET'),
      path: String(body.path || '/'),
      headers: (body.headers || {}) as EvaluationInput['headers'],
      body: body.body,
      ip: String(body.ip || 'unknown'),
      trafficLane: body.trafficLane === 'practice' ? 'practice' : undefined,
      extraSignals: Array.isArray(body.extraSignals) ? body.extraSignals : undefined,
      appId: named?.id || 'default',
    };
    try {
      const result = await evaluateRequest(input, opts.config, opts.store, {
        reputation: opts.reputation,
        mode: named?.mode,
        profiles: named?.profiles,
        appId: named?.id || 'default',
      });
      opts.telemetry.record(result);
      opts.alerts.fromResult(input.path, result);
      const event = opts.events.publish(input.path, input.ip, result);
      const hook = named?.webhookUrl || opts.webhookUrl;
      if (event && hook) postWebhook(hook, event);
      const decision = decisionFor(result, result.action === 'challenge' ? issueChallengeToken(opts.config.challengeSecret) : undefined);
      res.json({ result, response: decision?.body ?? null });
    } catch (error) {
      const profile = matchProfile(input.path, input.method, opts.config.profiles);
      log('error', 'evaluate_failed', { message: error instanceof Error ? error.message : 'error' });
      if (profile.failurePolicy === 'fail-closed') {
        res.status(503).json({ error: 'defense_unavailable', message: 'The evaluator failed and this route is fail-closed.' });
        return;
      }
      res.status(200).json({ error: 'defense_unavailable', failOpen: true, message: 'The evaluator failed and this route is fail-open.' });
    }
  });

  app.post('/v1/challenge/issue', (req, res) => {
    if (opts.apiToken && !adminOk(req, opts) && !tokensEqual(bearer(header(req, 'authorization')), opts.apiToken)) {
      res.status(401).json({ error: 'unauthorized' });
      return;
    }
    const token = issueChallengeToken(opts.config.challengeSecret);
    opts.telemetry.challengeIssued();
    res.json({ token, page: 'POST /v1/challenge/verify with {"answer":"CONTINUE","token":"...","ip":"..."}' });
  });

  app.post('/v1/challenge/verify', (req, res) => {
    const token = String(req.body?.token || '');
    const ip = String(req.body?.ip || req.ip || 'unknown');
    if (!challengePassed(req.body?.answer, token, opts.config.challengeSecret)) {
      opts.telemetry.challengeFailed();
      res.status(400).json({
        error: 'challenge_failed',
        message: 'The visitor check answer or token was not accepted.',
        httpStatus: 400,
      });
      return;
    }
    opts.telemetry.challengePassed();
    const clearance = issueClearance(opts.config.challengeSecret, ip);
    res.json({ ok: true, clearance, cookie: `fcgbds_clearance=${encodeURIComponent(clearance)}` });
  });

  app.get('/v1/events', (req, res) => {
    if (!requireAdmin(req, res, opts)) return;
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.flushHeaders?.();
    for (const event of opts.events.recent()) {
      res.write(`data: ${JSON.stringify(event)}\n\n`);
    }
    const unsubscribe = opts.events.subscribe((event) => {
      res.write(`data: ${JSON.stringify(event)}\n\n`);
    });
    req.on('close', unsubscribe);
  });

  app.get('/__fcgbds/challenge', (_req, res) => {
    res.type('html').send(challengePage(issueChallengeToken(opts.config.challengeSecret)));
  });

  app.post('/__fcgbds/challenge', (req, res) => {
    const ip = inputFrom(req, opts.config, req.path, req.method).ip;
    if (!challengePassed(req.body?.answer, String(req.body?.token || ''), opts.config.challengeSecret)) {
      opts.telemetry.challengeFailed();
      res.status(400).type('html').send(challengePage(issueChallengeToken(opts.config.challengeSecret)));
      return;
    }
    opts.telemetry.challengePassed();
    const clearance = issueClearance(opts.config.challengeSecret, ip);
    res.setHeader('Set-Cookie', `fcgbds_clearance=${encodeURIComponent(clearance)}; HttpOnly; SameSite=Lax; Path=/`);
    res.json({ ok: true, clearance });
  });

  app.use('/v1/forward-auth', async (req, res) => {
    if (opts.apiToken) {
      const presented = bearer(header(req, 'authorization')) || header(req, 'x-fcgbds-token');
      if (!tokensEqual(presented, opts.apiToken)) {
        res.status(401).json({ error: 'unauthorized', message: 'Forward-auth token did not match FCGBDS_API_TOKEN.' });
        return;
      }
    }
    const path = header(req, 'x-original-uri') || req.path;
    const method = header(req, 'x-original-method') || req.method;
    const input = inputFrom(req, opts.config, path.split('?')[0] || '/', method);
    const result = await evaluateRequest(input, opts.config, opts.store, { reputation: opts.reputation });
    opts.telemetry.record(result);
    applyDecisionHeaders((name, value) => res.setHeader(name, value), result);
    const nginx = header(req, 'x-fcgbds-nginx') === '1';
    const decision = decisionFor(result, result.action === 'challenge' ? issueChallengeToken(opts.config.challengeSecret) : undefined);
    if (!decision) {
      res.status(200).json({ decision: 'allow', score: result.score });
      return;
    }
    if (nginx && decision.status === 429) {
      res.status(401).json({ ...decision.body, httpStatus: 401, message: 'Visitor check required. NGINX auth_request receives this as 401 because it does not pass 429 through.' });
      return;
    }
    res.status(decision.status).json(decision.body);
  });

  app.use(createMiddleware({
    config: opts.config,
    store: opts.store,
    telemetry: opts.telemetry,
    alerts: opts.alerts,
    events: opts.events,
    reputation: opts.reputation,
    webhookUrl: opts.webhookUrl,
  }));

  app.all('/login', (_req, res) => res.json({ ok: true, route: 'login' }));
  app.all('/register', (_req, res) => res.json({ ok: true, route: 'register' }));
  app.all('/api/*path', (_req, res) => res.json({ ok: true, route: 'api' }));
  app.get('/', (_req, res) => res.json({ name: 'fcgbds', mode: opts.config.mode, version: opts.version }));

  app.use((error: unknown, _req: Request, res: Response, _next: NextFunction) => {
    log('error', 'request_error', { message: error instanceof Error ? error.message : 'error' });
    if (!res.headersSent) {
      res.status(400).json({ error: 'bad_request', message: 'The request could not be read.' });
    }
  });

  return app;
}
