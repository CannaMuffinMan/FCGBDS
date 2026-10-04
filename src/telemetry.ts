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

export class Telemetry {
  private live = emptyLane();
  private practice = emptyLane();

  record(result: EvaluationResult): void {
    const lane = result.trafficLane === 'practice' ? this.practice : this.live;
    lane.evaluated += 1;
    if (result.allowlisted) lane.allowlisted += 1;
    if (result.action === 'allow') lane.allowed += 1;
    if (result.wouldHaveBlocked) lane.observedWouldBlock += 1;
    if (result.wouldHaveChallenged) lane.observedWouldChallenge += 1;
    if (result.enforced && result.action === 'block') lane.enforcedBlocked += 1;
    if (result.enforced && result.action === 'challenge') lane.enforcedChallenged += 1;
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
