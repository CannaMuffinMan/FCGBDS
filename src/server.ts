import express from 'express';
import helmet from 'helmet';
import dotenv from 'dotenv';
import { AlertSink } from './alerts';
import { challengePassed, issueChallengeToken, challengePage } from './challenge';
import { loadConfigFromEnv } from './config';
import { createMiddleware } from './middleware';
import { createStore } from './store';
import { Telemetry } from './telemetry';

dotenv.config();

async function main(): Promise<void> {
  const config = loadConfigFromEnv();
  const store = await createStore({
    redisUrl: config.redisUrl,
    prefix: config.redisKeyPrefix,
    maxKeys: config.storeMaxKeys,
  });
  const telemetry = new Telemetry();
  const alerts = new AlertSink();
  const app = express();
  app.disable('x-powered-by');
  app.use(helmet({ contentSecurityPolicy: false }));
  app.use(express.json({ limit: '1mb' }));
  app.use(express.urlencoded({ extended: false }));

  app.get('/health', (_req, res) => {
    res.json({
      ok: true,
      mode: config.mode,
      store: store.backend(),
      version: process.env.npm_package_version || '2.0.0',
    });
  });

  app.get('/metrics', (_req, res) => {
    res.json({
      mode: config.mode,
      store: store.backend(),
      telemetry: telemetry.snapshot(),
      recentAlerts: alerts.recent().slice(-50),
    });
  });

  app.get('/__fcgbds/challenge', (_req, res) => {
    res.type('html').send(challengePage(issueChallengeToken(config.challengeSecret)));
  });

  app.post('/__fcgbds/challenge', (req, res) => {
    if (!challengePassed(req.body?.answer, String(req.body?.token || ''), config.challengeSecret)) {
      res.status(400).type('html').send(challengePage(issueChallengeToken(config.challengeSecret)));
      return;
    }
    res.json({ ok: true });
  });

  app.use(createMiddleware({ config, store, telemetry, alerts }));

  app.all('/login', (_req, res) => res.json({ ok: true, route: 'login' }));
  app.all('/register', (_req, res) => res.json({ ok: true, route: 'register' }));
  app.all('/api/*path', (_req, res) => res.json({ ok: true, route: 'api' }));
  app.get('/', (_req, res) => res.json({ name: 'fcgbds', mode: config.mode }));

  const port = Number.parseInt(process.env.PORT || '3001', 10);
  const host = process.env.HOST || '0.0.0.0';
  const server = app.listen(port, host, () => {
    console.log(`FCGBDS listening on ${host}:${port} mode=${config.mode} store=${store.backend()}`);
  });

  const shutdown = async () => {
    server.close();
    await store.close();
    process.exit(0);
  };
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
