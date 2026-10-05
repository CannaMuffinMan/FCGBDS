import assert from 'node:assert/strict';
import http from 'http';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { describe, it } from 'node:test';
import express from 'express';
import { createApp } from '../src/app';
import { AlertSink } from '../src/alerts';
import { issueClearance, clearanceValid } from '../src/challenge';
import { loadConfigFromEnv } from '../src/config';
import { decisionFor } from '../src/decision';
import { evaluateRequest } from '../src/evaluate';
import { EventBus } from '../src/events';
import { FcgbdsClient } from '../src/sdk/client';
import { MemoryStore } from '../src/store';
import { openSqlite } from '../src/sqlStore';
import { Telemetry } from '../src/telemetry';
import { createNodeHttpMiddleware } from '../src/adapters/nodeHttp';
import { fcgbdsFastifyPlugin } from '../src/adapters/fastify';
import { guardNextRequest } from '../src/adapters/next';
import type { DefenseConfig } from '../src/types';

function appConfig(mode: 'observe' | 'enforce' = 'enforce'): DefenseConfig {
  return loadConfigFromEnv({ FCGBDS_MODE: mode, FCGBDS_CHALLENGE_SECRET: 'test-secret' });
}

function harnessApp(mode: 'observe' | 'enforce' = 'enforce', extra: Partial<Parameters<typeof createApp>[0]> = {}) {
  const config = appConfig(mode);
  const store = new MemoryStore();
  const telemetry = new Telemetry();
  const events = new EventBus();
  const app = createApp({
    config,
    store,
    telemetry,
    alerts: new AlertSink(),
    events,
    apiToken: 'token',
    dashboardPassword: 'dash-secret',
    sessionSecret: 'session',
    wallPublic: true,
    version: '2.1.0',
    redisConfigured: false,
    ...extra,
  });
  return { app, config, store, telemetry, events };
}

function listen(app: express.Express): Promise<{ port: number; close: () => Promise<void> }> {
  return new Promise((resolve) => {
    const server = app.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (!address || typeof address === 'string') throw new Error('no port');
      resolve({
        port: address.port,
        close: () => new Promise((done) => server.close(() => done())),
      });
    });
  });
}

describe('v2 decisions', () => {
  it('deny list blocks in enforce and stays explicit', async () => {
    const store = new MemoryStore();
    await store.putList({ id: 'bad-ip', kind: 'deny', matchType: 'ip', value: '198.51.100.9' });
    const result = await evaluateRequest(
      { method: 'GET', path: '/', ip: '198.51.100.9', headers: { 'user-agent': 'Mozilla/5.0' }, body: {} },
      appConfig('enforce'),
      store,
    );
    assert.equal(result.denied, true);
    assert.equal(result.action, 'block');
    const decision = decisionFor(result);
    assert.ok(decision);
    assert.equal(decision?.status, 403);
    assert.equal(decision?.body.error, 'request_blocked');
    assert.ok(decision && decision.body.message.length > 0);
  });

  it('scores tls class mismatch and reputation hook', async () => {
    const result = await evaluateRequest(
      {
        method: 'GET',
        path: '/',
        ip: '203.0.113.50',
        headers: {
          'user-agent': 'Mozilla/5.0 Chrome/124.0.0.0',
          accept: 'text/html',
          'sec-fetch-mode': 'navigate',
          'sec-fetch-site': 'none',
          'x-fcgbds-tls-class': 'automated',
          host: 'localhost',
        },
        body: {},
      },
      appConfig('observe'),
      new MemoryStore(),
      { reputation: { async lookup() { return { score: 80, detail: 'listed' }; } } },
    );
    assert.equal(result.signals.find((s) => s.id === 'tls_consistency')?.triggered, true);
    assert.equal(result.signals.find((s) => s.id === 'ip_reputation')?.score, 50);
  });

  it('accepts a clearance bound to the same IP', () => {
    const token = issueClearance('test-secret', '203.0.113.8');
    assert.equal(clearanceValid('test-secret', token, '203.0.113.8'), true);
    assert.equal(clearanceValid('test-secret', token, '203.0.113.9'), false);
  });

  it('sqlite windows and lists survive a new handle', async () => {
    const file = path.join(os.tmpdir(), `fcgbds-${Date.now()}.sqlite`);
    const first = openSqlite(file);
    const count = await first.incrementWindow('b', 'k', 10_000, Date.now());
    assert.equal(count.count, 1);
    await first.putList({ id: 'a', kind: 'allow', matchType: 'path', value: '/healthz' });
    await first.setMeta('mode', 'enforce');
    await first.close();
    const second = openSqlite(file);
    const again = await second.incrementWindow('b', 'k', 10_000, Date.now());
    assert.equal(again.count, 2);
    assert.equal((await second.list('allow'))[0].value, '/healthz');
    assert.equal(await second.getMeta('mode'), 'enforce');
    await second.close();
    fs.rmSync(file, { force: true });
  });
});

describe('http api', () => {
  it('returns an explicit challenge body and dashboard stats', async () => {
    const { app } = harnessApp('enforce');
    const server = await listen(app);
    try {
      const blocked = await fetch(`http://127.0.0.1:${server.port}/login`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'user-agent': 'curl/8.0', accept: 'application/json' },
        body: JSON.stringify({ website: 'http://spam.example' }),
      });
      const body = await blocked.json() as { error: string; message: string; httpStatus: number };
      assert.equal(blocked.status, 403);
      assert.equal(body.error, 'request_blocked');
      assert.ok(body.message.length > 10);
      assert.equal(body.httpStatus, 403);

      const client = new FcgbdsClient(`http://127.0.0.1:${server.port}`, 'token');
      const evaluated = await client.evaluate({
        method: 'POST',
        path: '/login',
        ip: '203.0.113.8',
        headers: {
          'user-agent': 'python-requests/2.31',
          host: 'localhost',
        },
        body: { website: 'http://spam.example' },
      });
      assert.equal(evaluated.result.action, 'block');
      assert.ok(evaluated.response);

      const session = await fetch(`http://127.0.0.1:${server.port}/v1/session`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ password: 'dash-secret' }),
      });
      const cookie = String(session.headers.get('set-cookie') || '').split(';')[0];
      const stats = await fetch(`http://127.0.0.1:${server.port}/v1/stats`, { headers: { cookie } });
      const statsBody = await stats.json() as { stopped: number; checksIssued: number };
      assert.equal(stats.status, 200);
      assert.ok(statsBody.stopped >= 1);

      const wall = await fetch(`http://127.0.0.1:${server.port}/v1/wall`);
      assert.equal(wall.status, 200);
      const metrics = await fetch(`http://127.0.0.1:${server.port}/metrics`);
      assert.match(await metrics.text(), /fcgbds_stopped_total/);
    } finally {
      await server.close();
    }
  });

  it('node http middleware writes a JSON challenge or block', async () => {
    const config = loadConfigFromEnv({
      FCGBDS_MODE: 'enforce',
      FCGBDS_CHALLENGE_THRESHOLD: '40',
      FCGBDS_BLOCK_THRESHOLD: '50',
      FCGBDS_CHALLENGE_SECRET: 'test-secret',
    });
    const store = new MemoryStore();
    const guard = createNodeHttpMiddleware({ config, store });
    const server = http.createServer((req, res) => {
      void guard(req, res, () => {
        res.statusCode = 200;
        res.end('ok');
      });
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('port');
    try {
      const res = await fetch(`http://127.0.0.1:${address.port}/`, { headers: { 'user-agent': 'curl/8.0' } });
      const text = await res.text();
      assert.notEqual(text, '');
      assert.equal(res.status, 403);
      assert.equal(JSON.parse(text).error, 'request_blocked');
    } finally {
      await new Promise((resolve) => server.close(resolve));
    }
  });

  it('fastify plugin and next guard use the same decisions', async () => {
    const config = appConfig('enforce');
    const store = new MemoryStore();
    let sent: { status?: number; body?: unknown } = {};
    const plugin = fcgbdsFastifyPlugin({ config, store });
    plugin(
      {
        addHook(_name, handler) {
          void handler(
            {
              method: 'POST',
              url: '/login',
              ip: '198.51.100.20',
              headers: { 'user-agent': 'curl/8.0', host: 'localhost' },
              body: { website: 'http://x' },
            },
            {
              header() { return undefined; },
              code(status: number) {
                sent.status = status;
                return this;
              },
              send(body: unknown) {
                sent.body = body;
              },
            },
          );
        },
      },
      {},
      () => undefined,
    );
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(sent.status, 403);
    assert.equal((sent.body as { error: string }).error, 'request_blocked');

    const built = harnessApp('enforce');
    built.config.profiles = built.config.profiles.map((profile) => ({
      ...profile,
      challengeThreshold: 20,
      blockThreshold: 30,
    }));
    const server = await listen(built.app);
    try {
      const guarded = await guardNextRequest(new Request('http://app.example/login', { headers: { 'x-automated': '1' } }), {
        baseUrl: `http://127.0.0.1:${server.port}`,
        apiToken: 'token',
      });
      assert.ok(guarded);
      assert.equal(guarded?.status, 403);
      const payload = await guarded?.json() as { message: string };
      assert.ok(payload.message.includes('blocked'));
    } finally {
      await server.close();
    }
  });

  it('cloudflare worker returns the instance decision body', async () => {
    const worker = await import('../adapters/cloudflare/worker.js');
    const previous = global.fetch;
    global.fetch = (async () => new Response(JSON.stringify({
      result: { action: 'challenge', score: 70 },
      response: { error: 'challenge_required', message: 'Visitor check required before this request can continue.', httpStatus: 429, decision: 'challenge', score: 70, signals: ['automation'] },
    }), { status: 200, headers: { 'content-type': 'application/json' } })) as typeof fetch;
    try {
      const response = await worker.default.fetch(new Request('https://app.example/login'), { FCGBDS_URL: 'http://127.0.0.1:9' });
      assert.equal(response.status, 429);
      const body = await response.json() as { error: string; message: string };
      assert.equal(body.error, 'challenge_required');
      assert.ok(body.message.length > 0);
    } finally {
      global.fetch = previous;
    }
  });
});
