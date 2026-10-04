import { matchProfile } from './config';
import { runSignals } from './signals';
import type { DefenseConfig, DefenseStore, EvaluationInput, EvaluationResult, TrafficLane } from './types';

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

export async function evaluateRequest(
  input: EvaluationInput,
  config: DefenseConfig,
  store: DefenseStore,
): Promise<EvaluationResult> {
  const profile = matchProfile(input.path, input.method, config.profiles);
  const mode = profile.mode || config.mode;
  const trafficLane = lane(input, config);
  const allow = checkAllowlist(input, config);
  if (allow.ok) {
    return {
      action: 'allow',
      wouldHaveBlocked: false,
      wouldHaveChallenged: false,
      score: 0,
      signals: [],
      mode,
      enforced: false,
      profileId: profile.id,
      failurePolicy: profile.failurePolicy,
      allowlisted: true,
      allowlistReason: allow.reason,
      trafficLane,
      storeBackend: store.backend(),
    };
  }

  const signals = await runSignals(input, config, profile, store);
  const score = Math.min(100, signals.reduce((sum, s) => sum + s.score, 0));
  const challengeAt = profile.challengeThreshold ?? config.challengeThreshold;
  const blockAt = profile.blockThreshold ?? config.blockThreshold;
  const wouldHaveBlocked = score >= blockAt;
  const wouldHaveChallenged = !wouldHaveBlocked && score >= challengeAt;
  const intended: EvaluationResult['action'] = wouldHaveBlocked
    ? 'block'
    : wouldHaveChallenged
      ? 'challenge'
      : 'allow';
  const enforce = mode === 'enforce';
  return {
    action: enforce ? intended : 'allow',
    wouldHaveBlocked,
    wouldHaveChallenged,
    score,
    signals,
    mode,
    enforced: enforce && intended !== 'allow',
    profileId: profile.id,
    failurePolicy: profile.failurePolicy,
    allowlisted: false,
    trafficLane,
    storeBackend: store.backend(),
  };
}
