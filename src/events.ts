import http from 'http';
import https from 'https';
import { ipHash } from './challenge';
import type { DefenseEvent, EvaluationResult } from './types';

export class EventBus {
  private events: DefenseEvent[] = [];
  private listeners = new Set<(event: DefenseEvent) => void>();
  private seq = 0;

  constructor(private max = 200) {}

  publish(path: string, ip: string, result: EvaluationResult): DefenseEvent | null {
    if (result.action === 'allow' && !result.wouldHaveBlocked && !result.wouldHaveChallenged) return null;
    const event: DefenseEvent = {
      id: String(++this.seq),
      at: new Date().toISOString(),
      action: result.enforced ? result.action : result.wouldHaveBlocked ? 'block' : 'challenge',
      enforced: result.enforced,
      score: result.score,
      profileId: result.profileId,
      path,
      signals: result.signals.filter((s) => s.triggered).map((s) => s.id),
      trafficLane: result.trafficLane,
      ipHashPrefix: ipHash(ip),
    };
    this.events.push(event);
    if (this.events.length > this.max) this.events.shift();
    for (const listener of this.listeners) listener(event);
    return event;
  }

  recent(): DefenseEvent[] {
    return [...this.events];
  }

  subscribe(listener: (event: DefenseEvent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
}

export function postWebhook(url: string, event: DefenseEvent, timeoutMs = 1500): void {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return;
  }
  const body = JSON.stringify({ type: 'fcgbds.decision', event });
  const lib = parsed.protocol === 'https:' ? https : http;
  const req = lib.request(
    parsed,
    { method: 'POST', headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) }, timeout: timeoutMs },
    (res) => {
      res.resume();
    },
  );
  req.on('error', () => undefined);
  req.on('timeout', () => req.destroy());
  req.end(body);
}
