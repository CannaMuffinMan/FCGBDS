/**
 * Shared grading for FCGBDS worker harnesses.
 *
 * Ground truth (expectBlock, lane, run id) stays in this module and in the
 * report. Nothing here is sent to the scored host.
 */

export const DEFAULT_PROTECTED_PATHS = [
  '/api/auth/login',
  '/api/auth/register',
  '/api/auth/email/login',
  '/api/auth/email/register',
];

const EXACT_LABEL_HEADERS = new Set([
  'x-bot-test',
  'x-legit-traffic',
  'x-test-run-id',
  'x-automation-intent',
  'x-request-burst',
  'x-fcg-test-token',
]);

export function isHarnessLabelHeader(name) {
  const normalized = String(name || '').toLowerCase();
  if (normalized.startsWith('x-swarm-')) return true;
  return EXACT_LABEL_HEADERS.has(normalized);
}

/** Drop labels a scorer could read. Real visitor signals are left intact. */
export function stripHarnessLabels(headers) {
  const cleaned = {};
  for (const [name, value] of Object.entries(headers || {})) {
    if (isHarnessLabelHeader(name)) continue;
    cleaned[name] = value;
  }
  return cleaned;
}

export function resolveProtectedPaths(payload, env) {
  if (Array.isArray(payload?.protectedPaths) && payload.protectedPaths.length > 0) {
    return payload.protectedPaths.map((path) => String(path).trim()).filter(Boolean);
  }
  const raw = String(env?.BOT_DEFENSE_PATHS || env?.PROTECTED_PATHS || '').trim();
  if (raw) {
    return raw.split(',').map((path) => path.trim()).filter(Boolean);
  }
  return [...DEFAULT_PROTECTED_PATHS];
}

export function pathnameOnly(path) {
  return String(path || '').split('?')[0];
}

export function isInsideProtectedList(path, protectedPaths) {
  const clean = pathnameOnly(path);
  return (protectedPaths || []).some((prefix) => clean.startsWith(prefix));
}

export function parseGateBody(body) {
  if (!body || typeof body !== 'object') {
    return { code: '', action: '', score: null, ruleIds: [], gateDecision: false };
  }
  const code = String(body.code || '');
  const action = String(body.action || '');
  const score = typeof body.score === 'number' && Number.isFinite(body.score) ? body.score : null;
  const ruleIds = Array.isArray(body.ruleIds) ? body.ruleIds.map((id) => String(id)) : [];
  const gateDecision = code === 'request_blocked' || code === 'challenge_required';
  return { code, action, score, ruleIds, gateDecision };
}

/**
 * A catch counts only when the gate itself decided to block or challenge.
 * HTTP 400/401 (and a bare 403/429 with no gate body) are not bot catches.
 */
export function gradeObservation({ status, body, expectBlock, path, protectedPaths }) {
  const parsed = parseGateBody(body);
  const gateBlocked = parsed.gateDecision === true;
  const hostile = Boolean(expectBlock);
  let outcome = 'true_negative';
  if (hostile && gateBlocked) outcome = 'true_positive';
  else if (hostile && !gateBlocked) outcome = 'false_negative';
  else if (!hostile && gateBlocked) outcome = 'false_positive';

  const insideProtectedList = isInsideProtectedList(path, protectedPaths);
  return {
    status: Number(status) || 0,
    blocked: gateBlocked,
    gateBlocked,
    blockCode: parsed.code,
    gateAction: parsed.action,
    score: parsed.score,
    ruleIds: parsed.ruleIds,
    expectBlock: hostile,
    outcome,
    FAILURE: outcome === 'false_negative' || outcome === 'false_positive',
    FALSE_POS: outcome === 'false_positive',
    insideProtectedList,
    claimedAsDefense: insideProtectedList,
  };
}

/** Out-of-band correlation. The run id is logged here and never placed on the request. */
export function logHarnessCorrelation({ worker, waveId, lane, expectBlock, startedAt }) {
  const entry = {
    worker: String(worker || 'unknown'),
    waveId: String(waveId || ''),
    lane: lane || (expectBlock ? 'hostile' : 'legit'),
    expectBlock: Boolean(expectBlock),
    startedAt: startedAt || new Date().toISOString(),
  };
  console.log(JSON.stringify({ harnessCorrelation: entry }));
  return entry;
}

function emptyCounts() {
  return { truePositives: 0, falseNegatives: 0, falsePositives: 0, trueNegatives: 0, total: 0 };
}

function addOutcome(bucket, outcome) {
  bucket.total += 1;
  if (outcome === 'true_positive') bucket.truePositives += 1;
  else if (outcome === 'false_negative') bucket.falseNegatives += 1;
  else if (outcome === 'false_positive') bucket.falsePositives += 1;
  else bucket.trueNegatives += 1;
}

export function summarizeDefense(results, waves) {
  const defense = (results || []).filter((row) => row.claimedAsDefense);
  const outside = (results || []).filter((row) => !row.claimedAsDefense);
  const defenseCounts = emptyCounts();
  for (const row of defense) addOutcome(defenseCounts, row.outcome);

  const byWave = {};
  const waveMeta = new Map((waves || []).map((wave) => [wave.id, wave]));
  for (const row of results || []) {
    if (!byWave[row.wave]) {
      const meta = waveMeta.get(row.wave) || {};
      byWave[row.wave] = {
        id: row.wave,
        name: row.waveName || meta.name || row.wave,
        path: pathnameOnly(row.path || meta.path || ''),
        expectBlock: Boolean(row.expectBlock),
        insideProtectedList: Boolean(row.insideProtectedList),
        claimedAsDefense: Boolean(row.claimedAsDefense),
        note: row.claimedAsDefense
          ? 'Path is on the protected list. Counts below are gate decisions.'
          : 'Path is outside the protected list. These rows are not defense results.',
        ...emptyCounts(),
        rulesFired: {},
      };
    }
    const bucket = byWave[row.wave];
    if (row.claimedAsDefense) addOutcome(bucket, row.outcome);
    else bucket.total += 1;
    for (const ruleId of row.ruleIds || []) {
      bucket.rulesFired[ruleId] = (bucket.rulesFired[ruleId] || 0) + 1;
    }
  }

  const ruleIds = new Set();
  for (const row of defense) {
    for (const ruleId of row.ruleIds || []) ruleIds.add(ruleId);
  }
  const byRule = {};
  for (const ruleId of ruleIds) {
    const bucket = emptyCounts();
    for (const row of defense) {
      const fired = (row.ruleIds || []).includes(ruleId);
      const outcome = fired
        ? (row.expectBlock ? 'true_positive' : 'false_positive')
        : (row.expectBlock ? 'false_negative' : 'true_negative');
      addOutcome(bucket, outcome);
    }
    byRule[ruleId] = {
      ...bucket,
      meaning: 'Per-rule counts treat that rule firing as its own detector on protected-path requests. A false negative means this rule did not fire, even if another rule caught the request. Wave totals are the gate decision.',
    };
  }

  return {
    grading: 'gate_decision',
    gradingNote: 'A block counts only when the response code is request_blocked or challenge_required. HTTP 400 and 401 are not catches. Paths outside the protected list are reported separately and are not defense results.',
    defense: defenseCounts,
    outsideProtectedList: {
      total: outside.length,
      claimedAsDefense: false,
      paths: [...new Set(outside.map((row) => pathnameOnly(row.path)))],
    },
    byWave,
    byRule,
    failures: defense.filter((row) => row.FAILURE).length,
    falsePositives: defense.filter((row) => row.FALSE_POS).length,
    truePositives: defenseCounts.truePositives,
    falseNegatives: defenseCounts.falseNegatives,
    trueNegatives: defenseCounts.trueNegatives,
  };
}
