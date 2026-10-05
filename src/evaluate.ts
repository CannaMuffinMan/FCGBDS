import { resolveIntendedAction } from './actions';
import { matchProfile } from './config';
import { clearanceValid, readClearance } from './challenge';
import { matchList } from './lists';
import { runSignals } from './signals';
import type { DefenseConfig, DefenseStore, EvaluationInput, EvaluationResult, IpReputationHook, TrafficLane } from './types';

export interface EvaluateOptions {
  reputation?: IpReputationHook;
  hooks?: import('./types').SignalHook[];
  mode?: import('./types').RuntimeMode;
  profiles?: import('./types').RouteProfile[];
  appId?: string;
}

function header(headers: EvaluationInput['headers'], name: string): string {
  const raw = headers[name] ?? headers[name.toLowerCase()];
  if (Array.isArray(raw)) return raw.join(',');
  return String(raw || '');
}

function lane(input: EvaluationInput, config: DefenseConfig): TrafficLane {
  if (input.trafficLane) return input.trafficLane;
  const raw = header(input.headers, config.trafficLaneHeader).toLowerCase();
  return raw === 'practice' ? 'practice' : 'live';
}

function uaMatches(pattern: string, userAgent: string): boolean {
  return userAgent.toLowerCase().includes(pattern.toLowerCase());
}

function ipInCidr(ip: string, cidr: string): boolean {
  if (!cidr.includes('/')) return ip === cidr;
  const [range, bitsStr] = cidr.split('/');
  const bits = Number.parseInt(bitsStr, 10);
  if (!/^\d+\.\d+\.\d+\.\d+$/.test(ip) || !/^\d+\.\d+\.\d+\.\d+$/.test(range) || !Number.isFinite(bits)) {
    return false;
  }
  const toInt = (v: string) => v.split('.').reduce((acc, o) => (acc << 8) + Number(o), 0) >>> 0;
  const mask = bits === 0 ? 0 : (~0 << (32 - bits)) >>> 0;
  return (toInt(ip) & mask) === (toInt(range) & mask);
}

export function checkAllowlist(input: EvaluationInput, config: DefenseConfig): { ok: boolean; reason?: string } {
  const userAgent = header(input.headers, 'user-agent');
  for (const bot of config.knownGoodBots) {
    if (!uaMatches(bot.userAgentPattern, userAgent)) continue;
    if (!bot.ipCidrs?.length || bot.ipCidrs.some((cidr) => ipInCidr(input.ip, cidr))) {
      return { ok: true, reason: `known_bot:${bot.name}` };
    }
  }
  for (const hook of config.webhookAllowlist) {
    const pathOk = hook.pathPrefixes.some((p) => input.path === p || input.path.startsWith(p));
    if (!pathOk) continue;
    if (hook.requiredHeader && !header(input.headers, hook.requiredHeader)) continue;
    return { ok: true, reason: `webhook:${hook.name}` };
  }
  return { ok: false };
}

function baseResult(
  partial: Pick<EvaluationResult, 'action' | 'wouldHaveBlocked' | 'wouldHaveChallenged' | 'score' | 'signals' | 'enforced' | 'allowlisted'> &
    Partial<EvaluationResult>,
  shared: {
    mode: EvaluationResult['mode'];
    profileId: string;
    failurePolicy: EvaluationResult['failurePolicy'];
    trafficLane: TrafficLane;
    storeBackend: EvaluationResult['storeBackend'];
  },
): EvaluationResult {
  return {
    allowlistReason: undefined,
    denied: false,
    clearance: false,
    intendedAction: 'allow',
    rateLimited: false,
    appId: 'default',
    ...shared,
    ...partial,
  };
}

export async function evaluateRequest(
  input: EvaluationInput,
  config: DefenseConfig,
  store: DefenseStore,
  options: EvaluateOptions = {},
): Promise<EvaluationResult> {
  const profiles = options.profiles || config.profiles;
  const profile = matchProfile(input.path, input.method, profiles);
  const mode = profile.mode || options.mode || config.mode;
  const appId = options.appId || input.appId || 'default';
  const trafficLane = lane(input, config);
  const shared = {
    mode,
    profileId: profile.id,
    failurePolicy: profile.failurePolicy,
    trafficLane,
    storeBackend: store.backend(),
    appId,
  };

  const userAgent = header(input.headers, 'user-agent');
  const denied = matchList(await store.list('deny'), { ip: input.ip, userAgent, path: input.path, headers: input.headers });
  if (denied) {
    const enforce = mode === 'enforce';
    return baseResult(
      {
        action: enforce ? 'block' : 'allow',
        wouldHaveBlocked: true,
        wouldHaveChallenged: false,
        score: 100,
        signals: [{ id: 'deny_list', score: 100, triggered: true, detail: denied.id }],
        enforced: enforce,
        allowlisted: false,
        denied: true,
        denyReason: denied.id,
        intendedAction: 'block',
      },
      shared,
    );
  }

  const dynamicAllow = matchList(await store.list('allow'), { ip: input.ip, userAgent, path: input.path, headers: input.headers });
  const allow = dynamicAllow
    ? { ok: true, reason: `list:${dynamicAllow.id}` }
    : checkAllowlist(input, config);
  if (allow.ok) {
    return baseResult(
      {
        action: 'allow',
        wouldHaveBlocked: false,
        wouldHaveChallenged: false,
        score: 0,
        signals: [],
        enforced: false,
        allowlisted: true,
        allowlistReason: allow.reason,
      },
      shared,
    );
  }

  const clearance = readClearance(input.headers);
  if (clearance && clearanceValid(config.challengeSecret, clearance, input.ip)) {
    return baseResult(
      {
        action: 'allow',
        wouldHaveBlocked: false,
        wouldHaveChallenged: false,
        score: 0,
        signals: [],
        enforced: false,
        allowlisted: false,
        clearance: true,
      },
      shared,
    );
  }

  const signals = await runSignals(input, config, profile, store, options);
  if (options.hooks) {
    for (const hook of options.hooks) {
      const found = await hook.run(input);
      if (found && found.score > 0) signals.push({ ...found, id: found.id || hook.id });
    }
  }
  for (const extra of input.extraSignals || []) {
    const score = Math.max(0, Math.min(50, Math.round(Number(extra.score) || 0)));
    if (!extra.id || score <= 0) continue;
    signals.push({ id: String(extra.id).slice(0, 64), score, triggered: true, detail: extra.detail });
  }
  const score = Math.min(100, signals.reduce((sum, s) => sum + s.score, 0));
  const intended = resolveIntendedAction(score, profile, config);
  const velocity = signals.some((s) => s.id === 'velocity' && s.triggered);
  const rateLimited = intended === 'shadow' && profile.shadow === 'rate_limit' && velocity;
  const wouldHaveBlocked = intended === 'block';
  const wouldHaveChallenged = intended === 'challenge';
  const enforce = mode === 'enforce';
  let action: EvaluationResult['action'] = 'allow';
  if (enforce) {
    if (intended === 'flag' || intended === 'log' || (intended === 'shadow' && !rateLimited)) action = intended;
    else if (intended === 'shadow' && rateLimited) action = 'shadow';
    else action = intended;
  }
  return baseResult(
    {
      action,
      intendedAction: intended,
      rateLimited: enforce && rateLimited,
      wouldHaveBlocked,
      wouldHaveChallenged,
      score,
      signals,
      enforced: enforce && intended !== 'allow',
      allowlisted: false,
    },
    shared,
  );
}
