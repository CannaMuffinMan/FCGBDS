import dotenv from 'dotenv';
import { createApp } from './app';
import { AlertSink } from './alerts';
import { loadConfigFromEnv } from './config';
import { EventBus } from './events';
import { log } from './log';
import { httpReputationHook } from './reputation';
import { createStore } from './store';
import { Telemetry } from './telemetry';
import type { RouteProfile, RuntimeMode } from './types';

dotenv.config();

function env(name: string): string {
  return process.env[name]?.trim() || '';
}

async function main(): Promise<void> {
  const config = loadConfigFromEnv();
  const backend = (env('FCGBDS_STORE') || (config.redisUrl ? 'redis' : 'memory')) as 'memory' | 'redis' | 'postgres' | 'sqlite';
  const store = await createStore({
    backend,
    redisUrl: config.redisUrl,
    postgresUrl: env('FCGBDS_POSTGRES_URL') || env('DATABASE_URL'),
    sqlitePath: env('FCGBDS_SQLITE_PATH') || 'fcgbds.sqlite',
    prefix: config.redisKeyPrefix,
    maxKeys: config.storeMaxKeys,
  });
  const savedMode = await store.getMeta('mode');
  if (savedMode === 'observe' || savedMode === 'enforce') config.mode = savedMode as RuntimeMode;
  const savedProfiles = await store.getMeta('profiles');
  if (savedProfiles) {
    try {
      const parsed = JSON.parse(savedProfiles) as RouteProfile[];
      if (Array.isArray(parsed)) config.profiles = parsed;
    } catch {
      log('warn', 'profiles_meta_ignored', {});
    }
  }
  const telemetry = new Telemetry();
  const alerts = new AlertSink();
  const events = new EventBus();
  const reputationUrl = env('FCGBDS_REPUTATION_URL');
  const app = createApp({
    config,
    store,
    telemetry,
    alerts,
    events,
    reputation: reputationUrl ? httpReputationHook(reputationUrl) : undefined,
    apiToken: env('FCGBDS_API_TOKEN'),
    dashboardPassword: env('FCGBDS_DASHBOARD_PASSWORD'),
    sessionSecret: env('FCGBDS_SESSION_SECRET') || env('FCGBDS_CHALLENGE_SECRET') || 'ephemeral-dev-only',
    wallPublic: ['1', 'true', 'yes'].includes(env('FCGBDS_WALL_PUBLIC').toLowerCase()),
    webhookUrl: env('FCGBDS_EVENT_WEBHOOK_URL') || undefined,
    version: process.env.npm_package_version || '2.1.0',
    redisConfigured: backend === 'redis',
  });

  const port = Number.parseInt(process.env.PORT || '3001', 10);
  const host = process.env.HOST || '0.0.0.0';
  const server = app.listen(port, host, () => {
    log('info', 'listening', { host, port, mode: config.mode, store: store.backend() });
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
  log('error', 'startup_failed', { message: error instanceof Error ? error.message : 'error' });
  process.exit(1);
});
