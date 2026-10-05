/**
 * Shared FCGBDS worker harness helpers.
 *
 * Ground truth (expectBlock, lane, run id) stays in the report.
 * These helpers never attach that ground truth to a request the scorer can read.
 */

export const SCORER_LABEL_HEADER_NAMES = [
  'x-bot-test',
  'x-legit-traffic',
  'x-test-run-id',
  'x-automation-intent',
  'x-request-burst',
  'x-fcg-test-token',
];

/** Paths this repo's default middleware actually protects. */
export const DEFAULT_PROTECTED_PATHS = [
  '/api/auth/login',
  '/api/auth/register',
  '/api/auth/email/login',
  '/api/auth/email/register',
  '/api/user/profile',
  '/api/payment',
  '/api/chat-bridge/session/validate',
];

/**
 * Paths the workers probe that are outside that default list.
 * Results on these paths are reported, and are not defense results
 * unless a run's configured protected-path list covers them.
 */
export const KNOWN_UNPROTECTED_PROBE_PATHS = [
  '/api/platform/interact',
  '/api/wallet/status',
  '/api/health',
  '/api/bot-defense/stats',
  '/api/ecosystem/feed',
];

export function isScorerLabelHeader(name) {
  const lower = String(name || '').toLowerCase();
  if (SCORER_LABEL_HEADER_NAMES.includes(lower)) return true;
  if (lower.startsWith('x-swarm-')) return true;
  return false;
}

export function stripScorerVisibleLabels(headers) {
  const cleaned = {};
  for (const [name, value] of Object.entries(headers || {})) {
    if (isScorerLabelHeader(name)) continue;
    cleaned[name] = value;
  }
  return cleaned;
}

function splitPathList(value) {
  if (Array.isArray(value)) {
    return value.map((entry) => String(entry || '').trim()).filter(Boolean);
  }
  if (typeof value !== 'string') return [];
  return value.split(/[\s,]+/).map((entry) => entry.trim()).filter(Boolean);
}

export function resolveProtectedPaths(payload, env) {
  const fromPayload = splitPathList(payload && payload.protectedPaths);
  if (fromPayload.length) return fromPayload;
  const fromEnv = splitPathList(env && (env.BOT_DEFENSE_PATHS || env.PROTECTED_PATHS));
  if (fromEnv.length) return fromEnv;
  return DEFAULT_PROTECTED_PATHS.slice();
}

export function pathCoverage(path, protectedPaths) {
  const pathname = String(path || '').split('?')[0];
  const list = Array.isArray(protectedPaths) && protectedPaths.length
    ? protectedPaths
    : DEFAULT_PROTECTED_PATHS;
  const coveredByGate = list.some((prefix) => pathname === prefix || pathname.startsWith(prefix));
  return {
    path: pathname,
    coveredByGate,
    outsideProtectedList: !coveredByGate,
  };
}

function parseGateBody(body) {
  if (!body || typeof body !== 'object') {
    return { code: null, action: null, score: null, ruleIds: [] };
  }
  const code = typeof body.code === 'string' ? body.code : null;
  const action = typeof body.action === 'string' ? body.action : null;
  const score = typeof body.score === 'number' && Number.isFinite(body.score) ? body.score : null;
  const ruleIds = Array.isArray(body.ruleIds)
    ? body.ruleIds.filter((id) => typeof id === 'string' && id.length > 0)
    : [];
  return { code, action, score, ruleIds };
}

function gateDecision(parsed) {
  if (parsed.code === 'request_blocked' || parsed.action === 'block') return 'block';
  if (parsed.code === 'challenge_required' || parsed.action === 'challenge') return 'challenge';
  return null;
}

/**
 * Grade one response from the gate's own decision fields.
 * A catch is only 403 + request_blocked/block, or 429 + challenge_required/challenge.
 * 400, 401, and 5xx are not catches, even if a body repeats those codes.
 * Paths outside the protected list are recorded and not scored as defense.
 */
export function gradeObservedResponse(input) {
  const expectBlock = Boolean(input && input.expectBlock);
  const status = Number(input && input.status) || 0;
  const coverage = pathCoverage(input && input.path, input && input.protectedPaths);
  const parsed = parseGateBody(input && input.body);
  const decision = gateDecision(parsed);
  const lane = (input && input.lane) || (expectBlock ? 'hostile' : 'legit');
  const base = {
    wave: (input && input.waveId) || null,
    waveName: (input && input.waveName) || null,
    lane,
    runId: (input && input.runId) || null,
    path: coverage.path,
    status,
    expectBlock,
    score: parsed.score,
    ruleIds: parsed.ruleIds,
    blockCode: parsed.code,
    gateAction: parsed.action,
    coveredByGate: coverage.coveredByGate,
    outsideProtectedList: coverage.outsideProtectedList,
  };

  if (input && input.transportError) {
    return {
      ...base,
      blocked: false,
      graded: false,
      classification: 'error',
      FAILURE: expectBlock,
      FALSE_POS: false,
    };
  }

  if (coverage.outsideProtectedList) {
    return {
      ...base,
      blocked: false,
      graded: false,
      classification: 'ungraded',
      FAILURE: false,
      FALSE_POS: false,
    };
  }

  const blocked = (status === 403 && decision === 'block') || (status === 429 && decision === 'challenge');
  let classification = 'TN';
  if (expectBlock && blocked) classification = 'TP';
  else if (expectBlock && !blocked) classification = 'FN';
  else if (!expectBlock && blocked) classification = 'FP';

  return {
    ...base,
    blocked,
    graded: true,
    classification,
    FAILURE: classification === 'FN' || classification === 'FP',
    FALSE_POS: classification === 'FP',
  };
}

function emptyCounts() {
  return { TP: 0, FN: 0, FP: 0, TN: 0, ungraded: 0, error: 0 };
}

export function aggregateGateReport(results) {
  const counts = emptyCounts();
  const byWave = {};
  const byRule = {};
  const outsideProtectedPaths = [];
  const seenOutside = new Set();

  for (const result of results || []) {
    const classification = counts[result.classification] != null ? result.classification : 'ungraded';
    counts[classification] += 1;

    const waveKey = result.wave || 'unknown';
    if (!byWave[waveKey]) {
      byWave[waveKey] = {
        name: result.waveName || waveKey,
        path: result.path || null,
        expectBlock: Boolean(result.expectBlock),
        lane: result.lane || null,
        outsideProtectedList: Boolean(result.outsideProtectedList),
        ...emptyCounts(),
        byRule: {},
      };
    }
    byWave[waveKey][classification] += 1;

    if (result.outsideProtectedList && result.path && !seenOutside.has(result.path)) {
      seenOutside.add(result.path);
      const known = KNOWN_UNPROTECTED_PROBE_PATHS.includes(result.path);
      outsideProtectedPaths.push({
        path: result.path,
        wave: result.wave || null,
        knownProbeOutsideDefaultList: known,
        note: 'This path is outside the protected-path list used for this run. HTTP status here is not a gate decision and is not a defense result.',
      });
    }

    if (!result.graded || !Array.isArray(result.ruleIds)) continue;
    for (const ruleId of result.ruleIds) {
      if (!byRule[ruleId]) byRule[ruleId] = { fired: 0, ...emptyCounts() };
      byRule[ruleId].fired += 1;
      byRule[ruleId][classification] += 1;
      if (!byWave[waveKey].byRule[ruleId]) {
        byWave[waveKey].byRule[ruleId] = { fired: 0, ...emptyCounts() };
      }
      byWave[waveKey].byRule[ruleId].fired += 1;
      byWave[waveKey].byRule[ruleId][classification] += 1;
    }
  }

  return {
    counts,
    byWave,
    byRule,
    outsideProtectedPaths,
    gradedRequests: (results || []).filter((result) => result.graded).length,
    defenseClaimLimitedToProtectedPaths: true,
  };
}
