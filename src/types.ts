export type RuntimeMode = 'observe' | 'enforce';
export type FailurePolicy = 'fail-open' | 'fail-closed';
export type TrafficLane = 'live' | 'practice';
export type DecisionAction = 'allow' | 'challenge' | 'block';

export interface SignalResult {
  id: string;
  score: number;
  triggered: boolean;
  detail?: string;
}

export interface RouteProfile {
  id: string;
  /** Path prefixes this profile applies to. First match wins. */
  pathPrefixes: string[];
  methods?: string[];
  mode?: RuntimeMode;
  failurePolicy: FailurePolicy;
  challengeThreshold?: number;
  blockThreshold?: number;
  velocity?: {
    maxHits: number;
    windowMs: number;
  };
}

export interface KnownGoodBot {
  name: string;
  userAgentPattern: string;
  /** Optional CIDR list; if empty, UA match is enough. */
  ipCidrs?: string[];
}

export interface WebhookAllowlistEntry {
  name: string;
  pathPrefixes: string[];
  /** Header that must be present (for example Stripe-Signature). Value is not validated here. */
  requiredHeader?: string;
}

export interface DefenseConfig {
  mode: RuntimeMode;
  challengeThreshold: number;
  blockThreshold: number;
  expectedHostname?: string;
  redisUrl?: string;
  redisKeyPrefix: string;
  trustProxy: boolean;
  honeypotFields: string[];
  datacenterAsns: number[];
  asnHeader: string;
  trafficLaneHeader: string;
  profiles: RouteProfile[];
  knownGoodBots: KnownGoodBot[];
  webhookAllowlist: WebhookAllowlistEntry[];
  challengeSecret: string;
  storeMaxKeys: number;
}

export interface EvaluationInput {
  method: string;
  path: string;
  headers: Record<string, string | string[] | undefined>;
  body: unknown;
  ip: string;
  now?: number;
  trafficLane?: TrafficLane;
}

export interface EvaluationResult {
  action: DecisionAction;
  wouldHaveBlocked: boolean;
  wouldHaveChallenged: boolean;
  score: number;
  signals: SignalResult[];
  mode: RuntimeMode;
  enforced: boolean;
  profileId: string;
  failurePolicy: FailurePolicy;
  allowlisted: boolean;
  allowlistReason?: string;
  trafficLane: TrafficLane;
  storeBackend: 'redis' | 'memory';
}

export interface WindowCount {
  count: number;
  backend: 'redis' | 'memory';
}

export interface DefenseStore {
  incrementWindow(bucket: string, key: string, windowMs: number, now: number): Promise<WindowCount>;
  seenOnce(bucket: string, key: string, ttlMs: number): Promise<{ first: boolean; backend: 'redis' | 'memory' }>;
  backend(): 'redis' | 'memory';
  close(): Promise<void>;
}

export interface TelemetrySnapshot {
  live: LaneCounters;
  practice: LaneCounters;
}

export interface LaneCounters {
  evaluated: number;
  allowed: number;
  observedWouldBlock: number;
  observedWouldChallenge: number;
  enforcedBlocked: number;
  enforcedChallenged: number;
  allowlisted: number;
}
