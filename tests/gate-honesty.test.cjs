require('ts-node').register({
  transpileOnly: true,
  compilerOptions: { module: 'commonjs', esModuleInterop: true },
});

const test = require('node:test');
const assert = require('node:assert/strict');
const { createBotDefenseMiddleware } = require('../src/botDefense.ts');

let harness;
test.before(async () => {
  harness = await import('../cloudflare-workers/lib/gateHarness.js');
});

const LABEL_HEADERS = {
  'x-bot-test': 'true',
  'x-legit-traffic': 'true',
  'x-test-run-id': 'run-should-not-score',
  'x-swarm-id': 'swarm-a',
  'x-swarm-fingerprint': 'shared',
  'x-automation-intent': 'mass-replay',
  'x-request-burst': '400',
  'x-fcg-test-token': 'bypass-token',
};

function browserHeaders(extra = {}) {
  return {
    host: 'app.example',
    'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
    accept: 'application/json',
    referer: 'https://app.example/register',
    'sec-fetch-mode': 'cors',
    'sec-fetch-site': 'same-origin',
    ...extra,
  };
}

function scoredHeaders(extra = {}) {
  return {
    host: 'app.example',
    'user-agent': 'python-requests/2.32.3',
    accept: 'application/json',
    ...extra,
  };
}

function invoke(mw, req) {
  return new Promise((resolve) => {
    const res = {
      statusCode: 200,
      status(code) {
        this.statusCode = code;
        return this;
      },
      json(body) {
        resolve({ status: this.statusCode, body, next: false });
      },
    };
    mw.middleware(req, res, () => resolve({ status: 200, body: null, next: true }));
  });
}

test('label headers do not change the gate score or rules', async () => {
  const mw = createBotDefenseMiddleware({
    maxIpHits: 1000,
    maxDeviceHits: 1000,
    maxPayloadHits: 1000,
    redisUrl: '',
  });
  const body = { email: 'same-person@example.com', password: 'same-password' };
  const baseReq = {
    path: '/api/auth/email/register',
    method: 'POST',
    body,
    ip: '8.8.8.8',
    connection: { remoteAddress: '8.8.8.8' },
    headers: scoredHeaders(),
  };
  const labeledReq = {
    ...baseReq,
    headers: scoredHeaders(LABEL_HEADERS),
  };

  const plain = await invoke(mw, baseReq);
  const labeled = await invoke(mw, labeledReq);
  mw.destroy();

  assert.equal(plain.next, false);
  assert.equal(labeled.next, false);
  assert.equal(labeled.body.score, plain.body.score);
  assert.deepEqual(labeled.body.ruleIds, plain.body.ruleIds);
  assert.ok(!plain.body.ruleIds.includes('auth_write_test_forced_block'));
  assert.deepEqual(
    harness.stripScorerVisibleLabels(labeledReq.headers),
    harness.stripScorerVisibleLabels(baseReq.headers),
  );
});

test('X-Bot-Test on email register does not force a block', async () => {
  const mw = createBotDefenseMiddleware({
    maxIpHits: 1000,
    maxDeviceHits: 1000,
    maxPayloadHits: 1000,
    redisUrl: '',
  });
  const result = await invoke(mw, {
    path: '/api/auth/email/login',
    method: 'POST',
    body: { email: 'visitor@example.com', password: 'hunter2-ok' },
    ip: '1.1.1.1',
    connection: { remoteAddress: '1.1.1.1' },
    headers: browserHeaders({ 'x-bot-test': 'true' }),
  });
  mw.destroy();
  assert.equal(result.next, true);
  assert.equal(result.body, null);
});

test('automation user-agent substrings are a real UA signal', async () => {
  const samples = [
    'Mozilla/5.0 HeadlessChrome/124.0.0.0 Safari/537.36',
    'Mozilla/5.0 Playwright/1.44.0',
    'Mozilla/5.0 (Windows NT 10.0) Selenium/4.0',
    'node-fetch/3.3.2',
  ];
  for (const userAgent of samples) {
    const mw = createBotDefenseMiddleware({
      maxIpHits: 1000,
      maxDeviceHits: 1000,
      maxPayloadHits: 1000,
      redisUrl: '',
    });
    const result = await invoke(mw, {
      path: '/api/auth/email/register',
      method: 'POST',
      body: { email: `${userAgent.length}@example.com`, password: 'x' },
      ip: '9.9.9.9',
      connection: { remoteAddress: '9.9.9.9' },
      headers: {
        host: 'app.example',
        'user-agent': userAgent,
        accept: 'application/json',
        referer: 'https://app.example/',
        'sec-fetch-mode': 'cors',
        'sec-fetch-site': 'same-origin',
      },
    });
    mw.destroy();
    assert.equal(result.next, false, userAgent);
    assert.ok(result.body.ruleIds.includes('ua_anomaly'), userAgent);
    assert.ok(!result.body.ruleIds.includes('auth_write_test_forced_block'));
  }
});

test('grading uses ruleIds and ignores 400/401 as catches', () => {
  const protectedPaths = harness.DEFAULT_PROTECTED_PATHS;
  const caught = harness.gradeObservedResponse({
    status: 403,
    body: {
      code: 'request_blocked',
      action: 'block',
      score: 90,
      ruleIds: ['ua_anomaly', 'header_anomaly'],
    },
    expectBlock: true,
    path: '/api/auth/email/register',
    protectedPaths,
    waveId: 'H1',
    waveName: 'ua',
    runId: 'local-1',
  });
  assert.equal(caught.classification, 'TP');
  assert.deepEqual(caught.ruleIds, ['ua_anomaly', 'header_anomaly']);

  const appReject = harness.gradeObservedResponse({
    status: 401,
    body: { error: 'invalid credentials' },
    expectBlock: true,
    path: '/api/auth/email/login',
    protectedPaths,
    waveId: 'H1',
  });
  assert.equal(appReject.classification, 'FN');
  assert.equal(appReject.blocked, false);
  assert.deepEqual(appReject.ruleIds, []);

  const badRequest = harness.gradeObservedResponse({
    status: 400,
    body: { error: 'bad payload' },
    expectBlock: true,
    path: '/api/auth/email/register',
    protectedPaths,
    waveId: 'H1',
  });
  assert.equal(badRequest.classification, 'FN');

  const serverError = harness.gradeObservedResponse({
    status: 502,
    body: { code: 'request_blocked', action: 'block', score: 100, ruleIds: ['ua_anomaly'] },
    expectBlock: true,
    path: '/api/auth/email/register',
    protectedPaths,
    waveId: 'H1',
  });
  assert.equal(serverError.blocked, false);
  assert.equal(serverError.classification, 'FN');

  const wrongStatus = harness.gradeObservedResponse({
    status: 401,
    body: { code: 'request_blocked', action: 'block', score: 90, ruleIds: ['ua_anomaly'] },
    expectBlock: false,
    path: '/api/auth/email/login',
    protectedPaths,
    waveId: 'HF',
    lane: 'legit',
  });
  assert.equal(wrongStatus.classification, 'TN');
  assert.equal(wrongStatus.FAILURE, false);

  const report = harness.aggregateGateReport([caught, appReject]);
  assert.equal(report.counts.TP, 1);
  assert.equal(report.counts.FN, 1);
  assert.equal(report.byWave.H1.TP, 1);
  assert.equal(report.byWave.H1.FN, 1);
  assert.equal(report.byRule.ua_anomaly.TP, 1);
  assert.equal(report.byRule.ua_anomaly.fired, 1);
  assert.equal(report.byWave.H1.byRule.header_anomaly.TP, 1);
});

test('a legit lane records FAILURE when the gate blocks it', () => {
  const graded = harness.gradeObservedResponse({
    status: 429,
    body: {
      code: 'challenge_required',
      action: 'challenge',
      score: 60,
      ruleIds: ['header_anomaly'],
    },
    expectBlock: false,
    path: '/api/auth/email/login',
    protectedPaths: harness.DEFAULT_PROTECTED_PATHS,
    waveId: 'HF',
    lane: 'legit',
    runId: 'legit-run',
  });
  assert.equal(graded.classification, 'FP');
  assert.equal(graded.FAILURE, true);
  assert.equal(graded.FALSE_POS, true);
  assert.equal(graded.lane, 'legit');
  assert.equal(graded.runId, 'legit-run');

  const report = harness.aggregateGateReport([graded]);
  assert.equal(report.counts.FP, 1);
  assert.equal(report.byRule.header_anomaly.FP, 1);
});

test('unprotected probe paths are flagged and not claimed as defense', () => {
  const paths = [
    '/api/platform/interact',
    '/api/wallet/status',
    '/api/health',
    '/api/bot-defense/stats',
    '/api/ecosystem/feed',
  ];
  const results = paths.map((path) => harness.gradeObservedResponse({
    status: 403,
    body: { code: 'request_blocked', score: 99, ruleIds: ['ua_anomaly'] },
    expectBlock: true,
    path,
    protectedPaths: harness.DEFAULT_PROTECTED_PATHS,
    waveId: path,
  }));
  for (const result of results) {
    assert.equal(result.graded, false);
    assert.equal(result.classification, 'ungraded');
    assert.equal(result.blocked, false);
  }
  const report = harness.aggregateGateReport(results);
  assert.equal(report.counts.TP, 0);
  assert.equal(report.outsideProtectedPaths.length, paths.length);

  const overridden = harness.gradeObservedResponse({
    status: 403,
    body: { code: 'request_blocked', score: 90, ruleIds: ['ua_anomaly'] },
    expectBlock: true,
    path: '/api/health',
    protectedPaths: harness.resolveProtectedPaths({ protectedPaths: ['/api/health'] }, {}),
    waveId: 'custom',
  });
  assert.equal(overridden.classification, 'TP');
});
