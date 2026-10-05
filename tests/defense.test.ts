import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { evaluateRequest } from '../src/evaluate';
import { loadConfigFromEnv } from '../src/config';
import { MemoryStore } from '../src/store';
import { issueChallengeToken, verifyChallengeToken, challengePassed } from '../src/challenge';
import { Telemetry } from '../src/telemetry';
import { runHarness } from '../src/harness';
import type { EvaluationInput } from '../src/types';

function cfg(overrides: NodeJS.ProcessEnv = {}) {
  return loadConfigFromEnv({ FCGBDS_MODE: 'observe', ...overrides });
}

function browserInput(over: Partial<EvaluationInput> = {}): EvaluationInput {
  return {
    method: 'POST',
    path: '/login',
    ip: '203.0.113.8',
    body: { email: 'user@example.com' },
    headers: {
      'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
      accept: 'application/json',
      'accept-language': 'en',
      'sec-fetch-mode': 'navigate',
      'sec-fetch-site': 'same-origin',
      host: 'localhost',
    },
    ...over,
  };
}

describe('evaluate', () => {
  it('defaults to observe and reports would-have-blocked without enforcing', async () => {
    const store = new MemoryStore();
    const result = await evaluateRequest(
      browserInput({
        headers: { 'user-agent': 'curl/8.0', host: 'localhost' },
        body: { website: 'http://x' },
      }),
      cfg(),
      store,
    );
    assert.equal(result.mode, 'observe');
    assert.equal(result.action, 'allow');
    assert.equal(result.enforced, false);
    assert.equal(result.wouldHaveBlocked, true);
  });

  it('blocks in enforce mode for honeypot plus automation', async () => {
    const store = new MemoryStore();
    const result = await evaluateRequest(
      browserInput({
        headers: { 'user-agent': 'python-requests/2.31', host: 'localhost' },
        body: { website: 'http://x' },
      }),
      cfg({ FCGBDS_MODE: 'enforce' }),
      store,
    );
    assert.equal(result.action, 'block');
    assert.equal(result.enforced, true);
  });

  it('allowlists known good bots', async () => {
    const result = await evaluateRequest(
      browserInput({
        method: 'GET',
        path: '/',
        headers: { 'user-agent': 'Mozilla/5.0 (compatible; Googlebot/2.1)' },
      }),
      cfg(),
      new MemoryStore(),
    );
    assert.equal(result.allowlisted, true);
    assert.equal(result.action, 'allow');
    assert.equal(result.score, 0);
  });

  it('allowlists webhook paths with required header when configured', async () => {
    const config = cfg({ FCGBDS_WEBHOOK_SIGNATURE_HEADER: 'x-webhook-signature' });
    const result = await evaluateRequest(
      {
        method: 'POST',
        path: '/webhooks/example',
        ip: '203.0.113.50',
        body: { ok: true },
        headers: { 'user-agent': 'Hook/1.0', 'x-webhook-signature': 'sig' },
      },
      config,
      new MemoryStore(),
    );
    assert.equal(result.allowlisted, true);
  });
});

describe('signals', () => {
  it('flags missing browser sec-fetch headers', async () => {
    const result = await evaluateRequest(
      browserInput({
        headers: {
          'user-agent': 'Mozilla/5.0 Chrome/124.0.0.0 Safari/537.36',
          host: 'localhost',
        },
      }),
      cfg(),
      new MemoryStore(),
    );
    const signal = result.signals.find((s) => s.id === 'header_consistency');
    assert.ok(signal?.triggered);
  });

  it('flags nonce replay on second use', async () => {
    const store = new MemoryStore();
    const input = browserInput({
      headers: {
        ...(browserInput().headers as Record<string, string>),
        'idempotency-key': 'abc',
      },
    });
    const first = await evaluateRequest(input, cfg(), store);
    const second = await evaluateRequest(input, cfg(), store);
    assert.equal(first.signals.find((s) => s.id === 'replay')?.triggered, false);
    assert.equal(second.signals.find((s) => s.id === 'replay')?.triggered, true);
  });

  it('flags malformed bearer tokens', async () => {
    const result = await evaluateRequest(
      browserInput({
        headers: {
          ...(browserInput().headers as Record<string, string>),
          authorization: 'Bearer not-a-jwt-token-value-at-all-really',
        },
      }),
      cfg(),
      new MemoryStore(),
    );
    assert.ok(result.signals.find((s) => s.id === 'token_anomaly')?.triggered);
  });

  it('increments per-route velocity', async () => {
    const store = new MemoryStore();
    const config = cfg({ FCGBDS_PROTECTED_PATHS: '/login' });
    config.profiles[0].velocity = { maxHits: 3, windowMs: 60_000 };
    let last = await evaluateRequest(browserInput(), config, store);
    for (let i = 0; i < 4; i += 1) {
      last = await evaluateRequest(browserInput(), config, store);
    }
    assert.ok(last.signals.find((s) => s.id === 'velocity')?.triggered);
  });
});

describe('challenge', () => {
  it('issues and verifies tokens', () => {
    const frozen = issueChallengeToken('secret', 1_000);
    assert.equal(verifyChallengeToken('secret', frozen, 1_000), true);
    assert.equal(verifyChallengeToken('secret', frozen, 1_000 + 11 * 60_000), false);
    const live = issueChallengeToken('secret');
    assert.equal(challengePassed('continue', live, 'secret'), true);
    assert.equal(challengePassed('nope', live, 'secret'), false);
  });
});

describe('telemetry', () => {
  it('separates live vs practice and observed vs enforced', async () => {
    const telemetry = new Telemetry();
    const store = new MemoryStore();
    const observed = await evaluateRequest(
      browserInput({ body: { website: 'http://x' }, trafficLane: 'live' }),
      cfg(),
      store,
    );
    telemetry.record(observed);
    const enforced = await evaluateRequest(
      browserInput({
        trafficLane: 'practice',
        headers: { 'user-agent': 'curl/8.0', host: 'localhost' },
        body: { website: 'http://x' },
      }),
      cfg({ FCGBDS_MODE: 'enforce' }),
      store,
    );
    telemetry.record(enforced);
    const snap = telemetry.snapshot();
    assert.equal(snap.live.evaluated, 1);
    assert.equal(snap.live.enforcedBlocked, 0);
    assert.ok(snap.live.observedWouldBlock >= 1);
    assert.equal(snap.practice.evaluated, 1);
    assert.equal(snap.practice.enforcedBlocked, 1);
    assert.ok(snap.live.allowed + snap.live.enforcedBlocked + snap.live.enforcedChallenged <= snap.live.evaluated);
  });
});

describe('harness', () => {
  it('reports catch rate and false-positive rate', async () => {
    const report = await runHarness();
    assert.equal(report.total, report.good + report.bad);
    assert.ok(report.catchRate >= 0.75);
    assert.ok(report.falsePositiveRate <= 0.5);
  });
});

describe('store', () => {
  it('falls back to memory counters', async () => {
    const store = new MemoryStore(10);
    const a = await store.incrementWindow('t', 'k', 1000, 1000);
    const b = await store.incrementWindow('t', 'k', 1000, 1100);
    assert.equal(a.count, 1);
    assert.equal(b.count, 2);
    assert.equal(store.backend(), 'memory');
    const first = await store.seenOnce('n', '1', 5000);
    const second = await store.seenOnce('n', '1', 5000);
    assert.equal(first.first, true);
    assert.equal(second.first, false);
  });
});
