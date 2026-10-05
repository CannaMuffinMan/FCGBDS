export type RuntimeMode = 'observe' | 'enforce';
export type FailurePolicy = 'fail-open' | 'fail-closed';
export type TrafficLane = 'live' | 'practice';
export type DecisionAction = 'allow' | 'challenge' | 'block' | 'flag' | 'shadow' | 'log';
export type StoreBackend = 'memory' | 'redis' | 'postgres' | 'sqlite';
export type ListKind = 'allow' | 'deny';
export type ListMatchType = 'ip' | 'cidr' | 'ua' | 'path' | 'header';

export interface SignalResult {
  id: string;
  score: number;
  triggered: boolean;
  detail?: string;
}

export interface ActionRule {
  /** Apply when the score is at least this value. The highest matching minScore wins. */
  minScore: number;
  action: Exclude<DecisionAction, 'allow'>;
}

export interface RouteProfile {
  id: string;
  /** Path prefixes this profile applies to. First match wins. Names are yours. */
  pathPrefixes: string[];
  methods?: string[];
  mode?: RuntimeMode;
  failurePolicy: FailurePolicy;
  challengeThreshold?: number;
  blockThreshold?: number;
  /**
   * Replaces the challenge/block thresholds when set.
   * Actions: block, challenge, flag (allow + event), log (allow + event),
   * shadow (allow + header; optional rate limit).
   */
  actionRules?: ActionRule[];
  /**
   * mark: continue the request and set a shadow header.
   * rate_limit: when the velocity signal fired, respond 429 with an explicit rate_limited body.
   */
  shadow?: 'mark' | 'rate_limit';
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
  /** Header carrying an edge-observed TLS class: browser, automated, or unknown. */
  tlsClassHeader: string;
  /** Cap applied to a reputation hook score before it is added. */
  reputationScoreCap: number;
}

export interface EvaluationInput {
  method: string;
  path: string;
  headers: Record<string, string | string[] | undefined>;
  body: unknown;
  ip: string;
  now?: number;
  trafficLane?: TrafficLane;
  /** Scores computed by the caller. Each score is capped at 50 before it is added. */
  extraSignals?: Array<{ id: string; score: number; detail?: string }>;
  appId?: string;
}

export interface EvaluationResult {
  action: DecisionAction;
  /** Policy action before observe mode forces allow. */
  intendedAction: DecisionAction;
  /** True when shadow is configured as rate_limit and velocity fired. */
  rateLimited: boolean;
  appId: string;
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
  storeBackend: StoreBackend;
  denied: boolean;
  denyReason?: string;
  clearance: boolean;
}

export interface WindowCount {
  count: number;
  backend: StoreBackend;
}

export interface ListEntry {
  id: string;
  kind: ListKind;
  matchType: ListMatchType;
  value: string;
  note?: string;
}

export interface DefenseStore {
  incrementWindow(bucket: string, key: string, windowMs: number, now: number): Promise<WindowCount>;
  seenOnce(bucket: string, key: string, ttlMs: number): Promise<{ first: boolean; backend: StoreBackend }>;
  list(kind: ListKind): Promise<ListEntry[]>;
  putList(entry: ListEntry): Promise<void>;
  deleteList(kind: ListKind, id: string): Promise<boolean>;
  getMeta(key: string): Promise<string | null>;
  setMeta(key: string, value: string): Promise<void>;
  backend(): StoreBackend;
  close(): Promise<void>;
}

/** Operator-supplied IP reputation. The engine does not call any third-party reputation vendor. */
export interface IpReputationHook {
  lookup(ip: string): Promise<{ score: number; detail?: string } | null>;
}

export interface SignalHook {
  id: string;
  run(input: EvaluationInput): Promise<SignalResult | null> | SignalResult | null;
}

export interface TenantApp {
  id: string;
  name: string;
  keyHash: string;
  mode?: RuntimeMode;
  profiles?: RouteProfile[];
  webhookUrl?: string;
}

export interface DefenseEvent {
  id: string;
  at: string;
  appId: string;
  action: DecisionAction;
  enforced: boolean;
  score: number;
  profileId: string;
  path: string;
  signals: string[];
  trafficLane: TrafficLane;
  /** sha256 prefix of the client IP. Full IPs are not included. */
  ipHashPrefix: string;
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
