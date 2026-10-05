import type { DefenseConfig, FailurePolicy, RuntimeMode, RouteProfile } from './types';

function csv(value: string | undefined): string[] {
  if (!value?.trim()) return [];
  return value.split(/[\s,]+/).map((s) => s.trim()).filter(Boolean);
}

function envBool(value: string | undefined, fallback: boolean): boolean {
  if (value === undefined || value === '') return fallback;
  return !['0', 'false', 'no', 'off'].includes(value.toLowerCase());
}

function envInt(value: string | undefined, fallback: number): number {
  const n = Number.parseInt(String(value ?? ''), 10);
  return Number.isFinite(n) ? n : fallback;
}

function parseMode(value: string | undefined): RuntimeMode {
  return value === 'enforce' ? 'enforce' : 'observe';
}

function parseFailure(value: string | undefined, fallback: FailurePolicy): FailurePolicy {
  if (value === 'fail-closed') return 'fail-closed';
  if (value === 'fail-open') return 'fail-open';
  return fallback;
}

function defaultProfiles(): RouteProfile[] {
  return [
    {
      id: 'signup',
      pathPrefixes: ['/signup', '/register'],
      failurePolicy: 'fail-closed',
      velocity: { maxHits: 8, windowMs: 60_000 },
      challengeThreshold: 50,
      blockThreshold: 80,
    },
    {
      id: 'login',
      pathPrefixes: ['/login', '/api/auth', '/session'],
      failurePolicy: 'fail-closed',
      velocity: { maxHits: 12, windowMs: 60_000 },
      challengeThreshold: 50,
      blockThreshold: 80,
    },
    {
      id: 'reports',
      pathPrefixes: ['/reports', '/abuse', '/api/reports'],
      failurePolicy: 'fail-closed',
      velocity: { maxHits: 10, windowMs: 60_000 },
      challengeThreshold: 45,
      blockThreshold: 75,
    },
    {
      id: 'webhooks',
      pathPrefixes: ['/webhooks', '/api/webhooks'],
      failurePolicy: 'fail-open',
      mode: 'observe',
    },
    {
      id: 'default',
      pathPrefixes: ['/'],
      failurePolicy: 'fail-open',
      velocity: { maxHits: 60, windowMs: 60_000 },
    },
  ];
}

/** Load defense config from environment. No hostnames or secrets are hardcoded. */
export function loadConfigFromEnv(env: NodeJS.ProcessEnv = process.env): DefenseConfig {
  const customPrefixes = csv(env.FCGBDS_PROTECTED_PATHS);
  const profiles = defaultProfiles();
  if (customPrefixes.length > 0) {
    profiles.unshift({
      id: 'env-protected',
      pathPrefixes: customPrefixes,
      failurePolicy: parseFailure(env.FCGBDS_DEFAULT_FAILURE_POLICY, 'fail-closed'),
      velocity: {
        maxHits: envInt(env.FCGBDS_VELOCITY_MAX_HITS, 20),
        windowMs: envInt(env.FCGBDS_VELOCITY_WINDOW_MS, 60_000),
      },
    });
  }

  return {
    mode: parseMode(env.FCGBDS_MODE),
    challengeThreshold: envInt(env.FCGBDS_CHALLENGE_THRESHOLD, 60),
    blockThreshold: envInt(env.FCGBDS_BLOCK_THRESHOLD, 90),
    expectedHostname: env.FCGBDS_EXPECTED_HOSTNAME?.trim() || undefined,
    redisUrl: env.REDIS_URL?.trim() || env.FCGBDS_REDIS_URL?.trim() || undefined,
    redisKeyPrefix: env.FCGBDS_REDIS_PREFIX?.trim() || 'fcgbds',
    trustProxy: envBool(env.FCGBDS_TRUST_PROXY, true),
    honeypotFields: csv(env.FCGBDS_HONEYPOT_FIELDS).length
      ? csv(env.FCGBDS_HONEYPOT_FIELDS)
      : ['website', 'homepage', 'company_url'],
    datacenterAsns: csv(env.FCGBDS_DATACENTER_ASNS).map((s) => Number.parseInt(s, 10)).filter(Number.isFinite),
    asnHeader: env.FCGBDS_ASN_HEADER?.trim() || 'x-asn',
    trafficLaneHeader: env.FCGBDS_TRAFFIC_LANE_HEADER?.trim() || 'x-fcgbds-lane',
    profiles,
    knownGoodBots: [
      { name: 'googlebot', userAgentPattern: 'googlebot' },
      { name: 'bingbot', userAgentPattern: 'bingbot' },
      { name: 'cloudflare-health', userAgentPattern: 'cloudflare-healthchecks' },
    ],
    webhookAllowlist: [
      {
        name: 'generic-webhooks',
        pathPrefixes: ['/webhooks', '/api/webhooks'],
        requiredHeader: env.FCGBDS_WEBHOOK_SIGNATURE_HEADER?.trim() || undefined,
      },
    ],
    challengeSecret: env.FCGBDS_CHALLENGE_SECRET?.trim() || '',
    storeMaxKeys: envInt(env.FCGBDS_STORE_MAX_KEYS, 5000),
    tlsClassHeader: env.FCGBDS_TLS_CLASS_HEADER?.trim() || 'x-fcgbds-tls-class',
    reputationScoreCap: envInt(env.FCGBDS_REPUTATION_CAP, 50),
  };
}

export function matchProfile(path: string, method: string, profiles: RouteProfile[]): RouteProfile {
  const upper = method.toUpperCase();
  for (const profile of profiles) {
    if (profile.methods && !profile.methods.includes(upper)) continue;
    if (profile.pathPrefixes.some((prefix) => path === prefix || path.startsWith(prefix))) {
      return profile;
    }
  }
  return {
    id: 'unmatched',
    pathPrefixes: [],
    failurePolicy: 'fail-open',
  };
}
