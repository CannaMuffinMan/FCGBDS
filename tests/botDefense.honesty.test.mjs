import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
require('ts-node').register({ transpileOnly: true, compilerOptions: { module: 'commonjs', esModuleInterop: true } });
const { createBotDefenseMiddleware } = require('../src/botDefense.ts');

function run(middleware, headers, path = '/api/auth/email/register') {
  const req = {
    path,
    method: 'POST',
    headers,
    body: { email: 'a@example.com', password: 'secret' },
    ip: '203.0.113.10',
    connection: { remoteAddress: '203.0.113.10' },
  };
  const res = {
    statusCode: 200,
    body: null,
    status(code) {
      this.statusCode = code;
      return this;
    },
    json(payload) {
      this.body = payload;
      return this;
    },
  };
  let nextCalled = false;
  return middleware.middleware(req, res, () => {
    nextCalled = true;
  }).then(() => ({ res, nextCalled }));
}

const browserHeaders = {
  'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  accept: 'application/json',
  'accept-language': 'en-US',
  'sec-fetch-mode': 'cors',
  'sec-fetch-site': 'same-origin',
  referer: 'https://example.com/',
  host: 'example.com',
};

test('label headers do not change the score', async () => {
  const labels = {
    'x-bot-test': 'true',
    'x-legit-traffic': 'true',
    'x-test-run-id': 'run-9',
    'x-swarm-id': 'swarm',
    'x-swarm-fingerprint': 'fp',
    'x-automation-intent': 'mass-replay',
    'x-request-burst': '800',
    'x-fcg-test-token': 'bypass',
  };
  const plain = createBotDefenseMiddleware({ redisUrl: '' });
  const labeled = createBotDefenseMiddleware({ redisUrl: '' });
  const without = await run(plain, { ...browserHeaders });
  const withLabels = await run(labeled, { ...browserHeaders, ...labels });
  plain.destroy();
  labeled.destroy();
  assert.equal(without.nextCalled, true);
  assert.equal(withLabels.nextCalled, true);
  assert.equal(withLabels.res.body, null);
  const rules = JSON.stringify(withLabels.res.body || {});
  assert.equal(rules.includes('auth_write_test_forced_block'), false);
});

test('HeadlessChrome, Playwright, Selenium, and node-fetch user agents are scored', async () => {
  const cases = [
    'Mozilla/5.0 HeadlessChrome/124.0.0.0 Safari/537.36',
    'Mozilla/5.0 Playwright/1.44.0',
    'Mozilla/5.0 (selenium) Chrome/124.0.0.0',
    'node-fetch/3.3.2',
  ];
  for (const userAgent of cases) {
    const gate = createBotDefenseMiddleware({ redisUrl: '' });
    const result = await run(gate, { ...browserHeaders, 'user-agent': userAgent });
    gate.destroy();
    assert.equal(result.nextCalled, false, userAgent);
    assert.ok(result.res.body.ruleIds.includes('ua_anomaly'), userAgent);
    assert.equal(result.res.body.ruleIds.includes('auth_write_test_forced_block'), false);
  }
});

test('a normal browser user agent is not marked ua_anomaly', async () => {
  const gate = createBotDefenseMiddleware({ redisUrl: '' });
  const result = await run(gate, { ...browserHeaders });
  gate.destroy();
  assert.equal(result.nextCalled, true);
});
