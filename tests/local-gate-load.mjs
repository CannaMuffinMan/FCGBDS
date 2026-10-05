/**
 * Local-only synthetic load for the FCGBDS gate.
 * Refuses any target that is not a loopback host.
 */
import { gradeObservedResponse, aggregateGateReport, DEFAULT_PROTECTED_PATHS } from '../cloudflare-workers/lib/gateHarness.js';

const target = process.env.LOCAL_GATE_URL || 'http://127.0.0.1:3011';
const parsed = new URL(target);
const loopback = new Set(['127.0.0.1', 'localhost', '::1']);
if (!loopback.has(parsed.hostname)) {
  console.error(`Refusing non-local target ${parsed.hostname}`);
  process.exit(2);
}

const browserUa = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';
const botUa = 'python-requests/2.32.3';

function browserHeaders(extra = {}) {
  return {
    'content-type': 'application/json',
    accept: 'application/json',
    'user-agent': browserUa,
    referer: `${target}/`,
    'sec-fetch-mode': 'cors',
    'sec-fetch-site': 'same-origin',
    ...extra,
  };
}

async function one(spec) {
  const started = performance.now();
  let status = 0;
  let body = null;
  let transportError = false;
  try {
    const response = await fetch(`${target}${spec.path}`, {
      method: spec.method,
      headers: spec.headers,
      body: spec.body,
    });
    status = response.status;
    const text = await response.text();
    try { body = text ? JSON.parse(text) : null; } catch { body = null; }
  } catch {
    transportError = true;
  }
  const durationMs = performance.now() - started;
  const graded = gradeObservedResponse({
    status,
    body,
    expectBlock: spec.expectBlock,
    path: spec.path,
    protectedPaths: DEFAULT_PROTECTED_PATHS,
    waveId: spec.waveId,
    waveName: spec.waveName,
    lane: spec.expectBlock ? 'hostile' : 'legit',
    runId: 'local-vm',
    transportError,
  });
  return { ...graded, durationMs };
}

async function wave(spec, count) {
  const jobs = [];
  for (let i = 0; i < count; i += 1) {
    const expectBlock = spec.expectBlockFor ? spec.expectBlockFor(i) : spec.expectBlock;
    jobs.push(one({
      ...spec,
      expectBlock,
      body: spec.bodyFor ? spec.bodyFor(i) : spec.body,
      headers: spec.headersFor ? spec.headersFor(i) : spec.headers,
    }));
  }
  return Promise.all(jobs);
}

function percentile(values, p) {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const idx = Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1);
  return Number(sorted[Math.max(0, idx)].toFixed(2));
}

const labelHeaders = {
  'x-bot-test': 'true',
  'x-legit-traffic': 'true',
  'x-test-run-id': 'should-not-score',
  'x-swarm-id': 'local',
  'x-automation-intent': 'mass-replay',
  'x-request-burst': '900',
  'x-fcg-test-token': 'not-a-bypass',
};

const startedAll = performance.now();
const results = [];

results.push(...await wave({
  waveId: 'legit-login',
  waveName: 'browser login',
  method: 'POST',
  path: '/api/auth/email/login',
  expectBlock: false,
  headers: browserHeaders(),
  bodyFor: (i) => JSON.stringify({ email: `person${i}@example.com`, password: `unique-${i}-${Math.random()}` }),
}, 40));

results.push(...await wave({
  waveId: 'label-login',
  waveName: 'browser login plus harness labels',
  method: 'POST',
  path: '/api/auth/email/login',
  expectBlock: false,
  headers: browserHeaders(labelHeaders),
  bodyFor: (i) => JSON.stringify({ email: `labeled${i}@example.com`, password: `unique-label-${i}-${Math.random()}` }),
}, 40));

results.push(...await wave({
  waveId: 'bot-register',
  waveName: 'python-requests register',
  method: 'POST',
  path: '/api/auth/email/register',
  expectBlock: true,
  headers: { 'content-type': 'application/json', 'user-agent': botUa },
  bodyFor: (i) => JSON.stringify({ email: `bot${i}@example.invalid`, password: `bot-${i}-${Math.random()}`, username: `bot${i}` }),
}, 40));

results.push(...await wave({
  waveId: 'repeat-payload',
  waveName: 'identical auth body',
  method: 'POST',
  path: '/api/auth/email/login',
  expectBlockFor: (i) => i >= 8,
  headers: browserHeaders(),
  body: JSON.stringify({ email: 'same@example.com', password: 'same-password' }),
}, 24));

results.push(...await wave({
  waveId: 'health',
  waveName: 'health outside gate',
  method: 'GET',
  path: '/api/health',
  expectBlock: false,
  headers: browserHeaders(),
}, 10));

results.push(...await wave({
  waveId: 'platform',
  waveName: 'platform interact outside gate',
  method: 'POST',
  path: '/api/platform/interact',
  expectBlock: true,
  headers: { 'content-type': 'application/json', 'user-agent': botUa },
  body: JSON.stringify({ contentId: 'x' }),
}, 10));

const elapsedMs = performance.now() - startedAll;
const report = aggregateGateReport(results);
const durations = results.map((row) => row.durationMs);
const byWave = {};
for (const row of results) {
  if (!byWave[row.wave]) byWave[row.wave] = { n: 0, blocked: 0, classifications: {} };
  byWave[row.wave].n += 1;
  if (row.blocked) byWave[row.wave].blocked += 1;
  byWave[row.wave].classifications[row.classification] = (byWave[row.wave].classifications[row.classification] || 0) + 1;
  const sample = results.find((item) => item.wave === row.wave && item.ruleIds && item.ruleIds.length);
  if (sample) byWave[row.wave].sampleRuleIds = sample.ruleIds;
  const allowed = results.find((item) => item.wave === row.wave && item.status && !item.blocked);
  if (allowed) byWave[row.wave].sampleStatus = allowed.status;
}

console.log(JSON.stringify({
  target,
  requests: results.length,
  elapsedMs: Number(elapsedMs.toFixed(1)),
  latencyMs: {
    p50: percentile(durations, 50),
    p95: percentile(durations, 95),
    max: percentile(durations, 100),
  },
  counts: report.counts,
  outsideProtectedPaths: report.outsideProtectedPaths.map((row) => row.path),
  byWave,
}, null, 2));
