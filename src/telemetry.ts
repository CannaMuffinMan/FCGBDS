import type { LaneCounters, TelemetrySnapshot, TrafficLane } from './types';
import type { EvaluationResult } from './types';

function emptyLane(): LaneCounters {
  return {
    evaluated: 0,
    allowed: 0,
    observedWouldBlock: 0,
    observedWouldChallenge: 0,
    enforcedBlocked: 0,
    enforcedChallenged: 0,
    allowlisted: 0,
  };
}

export interface CheckCounters {
  checksIssued: number;
  passed: number;
  failed: number;
  stopped: number;
}

export class Telemetry {
  private live = emptyLane();
  private practice = emptyLane();
  private checks: CheckCounters = { checksIssued: 0, passed: 0, failed: 0, stopped: 0 };

  record(result: EvaluationResult): void {
    const lane = result.trafficLane === 'practice' ? this.practice : this.live;
    lane.evaluated += 1;
    if (result.allowlisted) lane.allowlisted += 1;
    if (result.action === 'allow') lane.allowed += 1;
    if (result.wouldHaveBlocked) lane.observedWouldBlock += 1;
    if (result.wouldHaveChallenged) lane.observedWouldChallenge += 1;
    if (result.enforced && result.action === 'block') {
      lane.enforcedBlocked += 1;
      this.checks.stopped += 1;
    }
    if (result.enforced && result.action === 'challenge') {
      lane.enforcedChallenged += 1;
      this.checks.checksIssued += 1;
    }
  }

  challengeIssued(): void {
    this.checks.checksIssued += 1;
  }

  challengePassed(): void {
    this.checks.passed += 1;
  }

  challengeFailed(): void {
    this.checks.failed += 1;
  }

  checksSnapshot(): CheckCounters & { notVerified: number } {
    const notVerified = this.checks.failed + Math.max(0, this.checks.checksIssued - this.checks.passed - this.checks.failed);
    return { ...this.checks, notVerified };
  }

  snapshot(): TelemetrySnapshot {
    return {
      live: { ...this.live },
      practice: { ...this.practice },
    };
  }

  lane(name: TrafficLane): LaneCounters {
    return name === 'practice' ? { ...this.practice } : { ...this.live };
  }
}
