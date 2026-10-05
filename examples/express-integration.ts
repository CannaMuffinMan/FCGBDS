# Express integration

```ts
import express from 'express';
import {
  AlertSink,
  createMiddleware,
  createStore,
  loadConfigFromEnv,
  Telemetry,
} from '../src';

export async function createApp() {
  const config = loadConfigFromEnv();
  const store = await createStore({
    redisUrl: config.redisUrl,
    prefix: config.redisKeyPrefix,
    maxKeys: config.storeMaxKeys,
  });
  const app = express();
  app.use(express.json());
  app.use(createMiddleware({
    config,
    store,
    telemetry: new Telemetry(),
    alerts: new AlertSink(),
  }));
  app.post('/login', (_req, res) => res.json({ ok: true }));
  return app;
}
