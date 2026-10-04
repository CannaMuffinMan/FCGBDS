import type { EvaluationResult } from './types';

export interface AlertEvent {
  at: string;
  kind: 'would_block' | 'blocked' | 'challenged' | 'store_fallback';
  path: string;
  score: number;
  profileId: string;
  trafficLane: string;
  signals: string[];
}

export class AlertSink {
  private events: AlertEvent[] = [];
  private max: number;

  constructor(max = 200) {
    this.max = max;
  }

  fromResult(path: string, result: EvaluationResult): void {
    if (!result.wouldHaveBlocked && !result.wouldHaveChallenged && result.action === 'allow') return;
    const kind: AlertEvent['kind'] = result.enforced
      ? result.action === 'block'
        ? 'blocked'
        : 'challenged'
      : 'would_block';
    this.push({
      at: new Date().toISOString(),
      kind,
      path,
      score: result.score,
      profileId: result.profileId,
      trafficLane: result.trafficLane,
      signals: result.signals.filter((s) => s.triggered).map((s) => s.id),
    });
  }

  push(event: AlertEvent): void {
    this.events.push(event);
    if (this.events.length > this.max) this.events.shift();
  }

  recent(): AlertEvent[] {
    return [...this.events];
  }
}
