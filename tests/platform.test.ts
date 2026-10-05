import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import express from 'express';
import { createApp } from '../src/app';
import { AlertSink } from '../src/alerts';
import { loadConfigFromEnv } from '../src/config';
import { evaluateRequest } from '../src/evaluate';
import { EventBus } from '../src/events';
import { MemoryStore } from '../src/store';
import { Telemetry } from '../src/telemetry';

function listen(app: express.Express): Promise<{ port: number; close: () => Promise<void> }> {
  return new Promise((resolve) => {
    const server = app.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (!address || typeof address === 'string') throw new Error('no port');
      resolve({ port: address.port, close: () => new Promise((done) => server.close(() => done())) });
    });
  });
}

describe('any-api policies', () => {
  it('flag and log continue, shadow can rate limit with a body', async () => {
    const config = loadConfigFromEnv({ FCGBDS_MODE: 'enforce', FCGBDS_CHALLENGE_SECRET: 's' });
    config.profiles = [
      {
        id: 'reports',
        pathPrefixes: ['/reports'],
        failurePolicy: 'fail-closed',
        actionRules: [
          { minScore: 30, action: 'flag' },
          { minScore: 80, action: 'block' },
        ],
      },
      {
        id: 'post',
        pathPrefixes: ['/posts'],
        failurePolicy: 'fail-open',
        shadow: 'rate_limit',
        velocity: { maxHits: 1, windowMs: 60_000 },
        actionRules: [{ minScore: 20, action: 'shadow' }],
      },
    ];
    const store = new MemoryStore();
    const flagged = await evaluateRequest(
      {
        method: 'POST',
        path: '/reports',
        ip: '203.0.113.4',
        headers: { 'user-agent': 'curl/8.0' },
        body: {},
        extraSignals: [{ id: 'reporter_new_account', score: 10 }],
      },
      config,
      store,
    );
    assert.equal(flagged.intendedAction, 'flag');
    assert.equal(flagged.action, 'flag');
    assert.ok(flagged.signals.some((s) => s.id === 'reporter_new_account'));

    const first = await evaluateRequest(
      { method: 'POST', path: '/posts', ip: '203.0.113.5', headers: { 'user-agent': 'curl/8.0' }, body: {} },
      config,
      store,
    );
    const second = await evaluateRequest(
      { method: 'POST', path: '/posts', ip: '203.0.113.5', headers: { 'user-agent': 'curl/8.0' }, body: {} },
      config,
      store,
    );
    assert.equal(first.action, 'shadow');
    assert.equal(first.rateLimited, false);
    assert.equal(second.rateLimited, true);
  });

  it('allowlists a machine client by header prefix', async () => {
    const config = loadConfigFromEnv({ FCGBDS_MODE: 'enforce' });
    const store = new MemoryStore();
    await store.putList({ id: 'billing-job', kind: 'allow', matchType: 'header', value: 'x-api-key:job_example_' });
    const result = await evaluateRequest(
      {
        method: 'POST',
        path: '/payments/capture',
        ip: '203.0.113.9',
        headers: { 'user-agent': 'curl/8.0', 'x-api-key': 'job_example_123' },
        body: {},
      },
      config,
      store,
    );
    assert.equal(result.allowlisted, true);
    assert.equal(result.action, 'allow');
  });

  it('keeps stats separate per app key', async () => {
    const config = loadConfigFromEnv({ FCGBDS_MODE: 'enforce', FCGBDS_CHALLENGE_SECRET: 's' });
    const store = new MemoryStore();
    const telemetry = new Telemetry();
    const app = createApp({
      config,
      store,
      telemetry,
      alerts: new AlertSink(),
      events: new EventBus(),
      apiToken: 'admin-token',
      dashboardPassword: '',
      sessionSecret: 'session',
      wallPublic: false,
      version: '2.2.0',
      redisConfigured: false,
    });
    const server = await listen(app);
    try {
      const created = await fetch(`http://127.0.0.1:${server.port}/v1/apps`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: 'Bearer admin-token' },
        body: JSON.stringify({
          id: 'shop',
          name: 'Shop API',
          mode: 'enforce',
          profiles: [{
            id: 'signup',
            pathPrefixes: ['/signup'],
            failurePolicy: 'fail-closed',
            actionRules: [{ minScore: 10, action: 'flag' }],
          }],
        }),
      });
      assert.equal(created.status, 201);
      const body = await created.json() as { apiKey: string };
      const decision = await fetch(`http://127.0.0.1:${server.port}/v1/evaluate`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${body.apiKey}` },
        body: JSON.stringify({
          method: 'POST',
          path: '/signup',
          ip: '203.0.113.20',
          headers: { 'user-agent': 'curl/8.0' },
        }),
      });
      const evaluated = await decision.json() as { result: { appId: string; action: string } };
      assert.equal(decision.status, 200);
      assert.equal(evaluated.result.appId, 'shop');
      assert.equal(evaluated.result.action, 'flag');
      const other = await fetch(`http://127.0.0.1:${server.port}/v1/evaluate`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: 'Bearer admin-token' },
        body: JSON.stringify({ method: 'GET', path: '/login', ip: '203.0.113.21', headers: { 'user-agent': 'curl/8.0' } }),
      });
      const otherBody = await other.json() as { result: { appId: string } };
      assert.equal(otherBody.result.appId, 'default');
      const stats = await fetch(`http://127.0.0.1:${server.port}/v1/stats`, {
        headers: { authorization: 'Bearer admin-token' },
      });
      const snap = await stats.json() as { apps: Record<string, { evaluated: number }> };
      assert.equal(snap.apps.shop.evaluated, 1);
      assert.equal(snap.apps.default.evaluated, 1);
    } finally {
      await server.close();
    }
  });
});
