import test from 'node:test';
import assert from 'node:assert/strict';
import {
  stripHarnessLabels,
  gradeObservation,
  summarizeDefense,
  isHarnessLabelHeader,
} from '../cloudflare-workers/harness/gateGrade.js';

const protectedPaths = ['/api/auth/email/login', '/api/auth/email/register'];

test('label headers are stripped and never treated as visitor signals', () => {
  const cleaned = stripHarnessLabels({
    'User-Agent': 'Mozilla/5.0',
    'X-Bot-Test': 'true',
    'X-Legit-Traffic': 'true',
    'X-Test-Run-Id': 'run-1',
    'X-Swarm-Id': 'swarm',
    'X-Swarm-Pattern': 'burst',
    'X-Automation-Intent': 'mass-replay',
    'X-Request-Burst': '400',
    'X-FCG-Test-Token': 'secret',
    Accept: 'application/json',
  });
  assert.deepEqual(Object.keys(cleaned).sort(), ['Accept', 'User-Agent']);
  assert.equal(isHarnessLabelHeader('x-swarm-wave'), true);
  assert.equal(isHarnessLabelHeader('user-agent'), false);
});

test('grading uses gate rule ids and ignores 400 and 401', () => {
  const authFail = gradeObservation({
    status: 401,
    body: { error: 'invalid credentials' },
    expectBlock: true,
    path: '/api/auth/email/login',
    protectedPaths,
  });
  assert.equal(authFail.blocked, false);
  assert.equal(authFail.outcome, 'false_negative');
  assert.equal(authFail.FAILURE, true);
  assert.deepEqual(authFail.ruleIds, []);

  const validation = gradeObservation({
    status: 400,
    body: { error: 'bad request' },
    expectBlock: true,
    path: '/api/auth/email/register',
    protectedPaths,
  });
  assert.equal(validation.outcome, 'false_negative');

  const gateBlock = gradeObservation({
    status: 403,
    body: { code: 'request_blocked', action: 'block', score: 95, ruleIds: ['ua_anomaly'] },
    expectBlock: true,
    path: '/api/auth/email/register',
    protectedPaths,
  });
  assert.equal(gateBlock.outcome, 'true_positive');
  assert.deepEqual(gateBlock.ruleIds, ['ua_anomaly']);
  assert.equal(gateBlock.score, 95);

  const bare403 = gradeObservation({
    status: 403,
    body: { error: 'forbidden' },
    expectBlock: true,
    path: '/api/auth/email/login',
    protectedPaths,
  });
  assert.equal(bare403.blocked, false);
  assert.equal(bare403.outcome, 'false_negative');
});

test('a legit lane records failure when the gate blocks or challenges', () => {
  const blocked = gradeObservation({
    status: 403,
    body: { code: 'request_blocked', action: 'block', score: 90, ruleIds: ['ua_anomaly'] },
    expectBlock: false,
    path: '/api/auth/email/login',
    protectedPaths,
  });
  assert.equal(blocked.outcome, 'false_positive');
  assert.equal(blocked.FAILURE, true);
  assert.equal(blocked.FALSE_POS, true);

  const challenged = gradeObservation({
    status: 429,
    body: { code: 'challenge_required', action: 'challenge', score: 60, ruleIds: ['header_anomaly'] },
    expectBlock: false,
    path: '/api/auth/email/register',
    protectedPaths,
  });
  assert.equal(challenged.FALSE_POS, true);

  const allowed = gradeObservation({
    status: 200,
    body: { ok: true },
    expectBlock: false,
    path: '/api/auth/email/login',
    protectedPaths,
  });
  assert.equal(allowed.outcome, 'true_negative');
  assert.equal(allowed.FAILURE, false);
});

test('paths outside the protected list are not claimed as defense results', () => {
  const rows = [
    {
      wave: 'P1',
      waveName: 'interact',
      path: '/api/platform/interact',
      ...gradeObservation({
        status: 200,
        body: {},
        expectBlock: true,
        path: '/api/platform/interact',
        protectedPaths,
      }),
    },
    {
      wave: 'H1',
      waveName: 'register',
      path: '/api/auth/email/register',
      ...gradeObservation({
        status: 403,
        body: { code: 'request_blocked', score: 90, ruleIds: ['ua_anomaly'] },
        expectBlock: true,
        path: '/api/auth/email/register',
        protectedPaths,
      }),
    },
  ];
  const summary = summarizeDefense(rows, []);
  assert.equal(summary.defense.truePositives, 1);
  assert.equal(summary.defense.falseNegatives, 0);
  assert.equal(summary.outsideProtectedList.total, 1);
  assert.equal(summary.byWave.P1.claimedAsDefense, false);
  assert.equal(summary.byRule.ua_anomaly.truePositives, 1);
  assert.equal(summary.byRule.ua_anomaly.falseNegatives, 0);
});
