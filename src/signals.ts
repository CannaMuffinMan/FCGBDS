import crypto from 'crypto';
import type { DefenseConfig, EvaluationInput, SignalResult } from './types';
import type { DefenseStore } from './types';
import type { RouteProfile } from './types';

function header(headers: EvaluationInput['headers'], name: string): string {
  const raw = headers[name] ?? headers[name.toLowerCase()];
  if (Array.isArray(raw)) return raw.join(',');
  return String(raw || '');
}

function ua(input: EvaluationInput): string {
  return header(input.headers, 'user-agent').toLowerCase();
}

function ipAsnSignal(input: EvaluationInput, config: DefenseConfig): SignalResult {
  const ip = input.ip || '';
  const asnRaw = header(input.headers, config.asnHeader);
  const asn = Number.parseInt(asnRaw, 10);
  const privateIp = /^(10\.|127\.|169\.254\.|172\.(1[6-9]|2\d|3[0-1])\.|192\.168\.|::1|fc00:|fe80:)/i.test(ip);
  const datacenter = Number.isFinite(asn) && config.datacenterAsns.includes(asn);
  let score = 0;
  const details: string[] = [];
  if (privateIp && header(input.headers, 'x-forwarded-for')) {
    score += 20;
    details.push('private_forwarded_ip');
  }
  if (datacenter) {
    score += 15;
    details.push(`datacenter_asn_${asn}`);
  }
  return { id: 'ip_asn', score, triggered: score > 0, detail: details.join(',') || undefined };
}

function deviceSignal(input: EvaluationInput): { result: SignalResult; hash: string } {
  const parts = [
    header(input.headers, 'user-agent'),
    header(input.headers, 'accept-language'),
    header(input.headers, 'sec-ch-ua'),
    header(input.headers, 'sec-ch-ua-platform'),
    header(input.headers, 'x-device-id'),
  ];
  const hash = crypto.createHash('sha256').update(parts.join('|')).digest('hex');
  const uaHeader = ua(input);
  const chUa = header(input.headers, 'sec-ch-ua').toLowerCase();
  let score = 0;
  if (uaHeader.includes('chrome') && chUa && !chUa.includes('chrome') && !chUa.includes('chromium')) {
    score += 25;
  }
  return {
    hash,
    result: { id: 'device', score, triggered: score > 0, detail: score ? 'ua_ch_mismatch' : undefined },
  };
}

function headerConsistency(input: EvaluationInput, config: DefenseConfig): SignalResult {
  const host = header(input.headers, 'host').toLowerCase().split(':')[0];
  const expected = (config.expectedHostname || '').toLowerCase();
  const userAgent = ua(input);
  const looksBrowser = /mozilla\/|chrome\/|safari\/|firefox\//.test(userAgent);
  let score = 0;
  const details: string[] = [];
  if (expected && host && host !== expected && host !== `www.${expected}`) {
    score += 40;
    details.push('host_mismatch');
  }
  if (looksBrowser) {
    const secFetch = header(input.headers, 'sec-fetch-mode') && header(input.headers, 'sec-fetch-site');
    const accept = header(input.headers, 'accept');
    if (!secFetch) {
      score += 20;
      details.push('missing_sec_fetch');
    }
    if (!accept) {
      score += 10;
      details.push('missing_accept');
    }
  }
  if (!userAgent) {
    score += 30;
    details.push('missing_ua');
  }
  return { id: 'header_consistency', score, triggered: score > 0, detail: details.join(',') || undefined };
}

async function velocitySignal(
  input: EvaluationInput,
  profile: RouteProfile,
  store: DefenseStore,
  deviceHash: string,
): Promise<SignalResult> {
  const now = input.now ?? Date.now();
  const limits = profile.velocity || { maxHits: 40, windowMs: 60_000 };
  const ip = await store.incrementWindow(`vel:ip:${profile.id}`, input.ip || 'unknown', limits.windowMs, now);
  const route = await store.incrementWindow(
    `vel:route:${profile.id}`,
    `${input.method}:${input.path}:${input.ip}`,
    limits.windowMs,
    now,
  );
  const device = await store.incrementWindow(`vel:dev:${profile.id}`, deviceHash, limits.windowMs, now);
  let score = 0;
  const details: string[] = [];
  if (ip.count > limits.maxHits) {
    score += 30;
    details.push(`ip_${ip.count}`);
  }
  if (route.count > Math.max(4, Math.floor(limits.maxHits / 2))) {
    score += 25;
    details.push(`route_${route.count}`);
  }
  if (device.count > limits.maxHits) {
    score += 20;
    details.push(`device_${device.count}`);
  }
  return { id: 'velocity', score, triggered: score > 0, detail: details.join(',') || undefined };
}

function payloadSignal(input: EvaluationInput): { result: SignalResult; signature: string } {
  const body = input.body && typeof input.body === 'object' ? JSON.stringify(input.body) : String(input.body ?? '');
  const signature = crypto.createHash('sha256').update(`${input.method}|${input.path}|${body}`).digest('hex');
  let score = 0;
  const details: string[] = [];
  if (body.length > 200_000) {
    score += 20;
    details.push('oversized_body');
  }
  if (typeof input.body === 'object' && input.body && Array.isArray((input.body as { extra?: unknown }).extra)) {
    score += 10;
  }
  const keys = input.body && typeof input.body === 'object' ? Object.keys(input.body as object) : [];
  if (keys.length > 80) {
    score += 15;
    details.push('high_key_cardinality');
  }
  return {
    signature,
    result: { id: 'payload', score, triggered: score > 0, detail: details.join(',') || undefined },
  };
}

function tokenAnomaly(input: EvaluationInput): SignalResult {
  const auth = header(input.headers, 'authorization');
  const token = header(input.headers, 'x-api-token') || header(input.headers, 'x-access-token');
  let score = 0;
  const details: string[] = [];
  if (auth.toLowerCase().startsWith('bearer ')) {
    const jwt = auth.slice(7).trim();
    const parts = jwt.split('.');
    if (jwt && parts.length !== 3 && jwt.length > 20) {
      score += 25;
      details.push('malformed_bearer');
    }
    if (jwt.length > 8_000) {
      score += 20;
      details.push('oversized_token');
    }
  }
  if (token && /\s/.test(token)) {
    score += 15;
    details.push('token_whitespace');
  }
  return { id: 'token_anomaly', score, triggered: score > 0, detail: details.join(',') || undefined };
}

function automationSignal(input: EvaluationInput): SignalResult {
  const userAgent = ua(input);
  const automationHints = [
    'headlesschrome',
    'puppeteer',
    'playwright',
    'selenium',
    'phantomjs',
    'python-requests',
    'curl/',
    'wget/',
    'go-http-client',
    'okhttp',
    'libwww-perl',
    'httpie',
  ];
  let score = 0;
  const details: string[] = [];
  for (const hint of automationHints) {
    if (userAgent.includes(hint)) {
      score += hint.includes('headless') || hint.includes('puppeteer') || hint.includes('playwright') ? 65 : 55;
      details.push(hint);
      break;
    }
  }
  if (header(input.headers, 'x-headless') === '1' || header(input.headers, 'x-automated') === '1') {
    score += 40;
    details.push('explicit_automation_header');
  }
  const webdriver = header(input.headers, 'x-webdriver') || header(input.headers, 'sec-ch-ua-model');
  if (webdriver.toLowerCase() === 'true') {
    score += 30;
    details.push('webdriver');
  }
  return { id: 'automation', score: Math.min(score, 80), triggered: score > 0, detail: details.join(',') || undefined };
}

async function replaySignal(
  input: EvaluationInput,
  payloadSignature: string,
  store: DefenseStore,
): Promise<SignalResult> {
  const now = input.now ?? Date.now();
  const nonce = header(input.headers, 'idempotency-key') || header(input.headers, 'x-nonce');
  let score = 0;
  const details: string[] = [];
  if (nonce) {
    const once = await store.seenOnce('nonce', `${input.path}:${nonce}`, 10 * 60_000);
    if (!once.first) {
      score += 50;
      details.push('nonce_replay');
    }
  }
  const repeats = await store.incrementWindow('payload', payloadSignature, 120_000, now);
  if (repeats.count > 8) {
    score += repeats.count > 16 ? 40 : 20;
    details.push(`payload_repeat_${repeats.count}`);
  }
  return { id: 'replay', score, triggered: score > 0, detail: details.join(',') || undefined };
}

function honeypotSignal(input: EvaluationInput, config: DefenseConfig): SignalResult {
  const body = input.body;
  if (!body || typeof body !== 'object') {
    return { id: 'honeypot', score: 0, triggered: false };
  }
  const record = body as Record<string, unknown>;
  for (const field of config.honeypotFields) {
    const value = record[field];
    if (typeof value === 'string' && value.trim()) {
      return { id: 'honeypot', score: 90, triggered: true, detail: field };
    }
  }
  return { id: 'honeypot', score: 0, triggered: false };
}

export async function runSignals(
  input: EvaluationInput,
  config: DefenseConfig,
  profile: RouteProfile,
  store: DefenseStore,
): Promise<SignalResult[]> {
  const ipAsn = ipAsnSignal(input, config);
  const device = deviceSignal(input);
  const headers = headerConsistency(input, config);
  const velocity = await velocitySignal(input, profile, store, device.hash);
  const payload = payloadSignal(input);
  const token = tokenAnomaly(input);
  const automation = automationSignal(input);
  const replay = await replaySignal(input, payload.signature, store);
  const honeypot = honeypotSignal(input, config);
  return [ipAsn, device.result, headers, velocity, payload.result, token, automation, replay, honeypot];
}
