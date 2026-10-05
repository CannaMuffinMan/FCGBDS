import type { EvaluationResult } from './types';

export interface RateLimitBody {
  error: 'rate_limited';
  message: string;
  httpStatus: 429;
  decision: 'shadow';
  score: number;
  signals: string[];
  profileId: string;
  mode: string;
}

export interface DecisionBody {
  error: 'challenge_required' | 'request_blocked';
  message: string;
  httpStatus: 429 | 403;
  decision: 'challenge' | 'block';
  score: number;
  signals: string[];
  profileId: string;
  mode: string;
  token?: string;
}

/** Explicit challenge (429), block (403), or shadow rate limit (429). Callers must send `body`. */
export function decisionFor(
  result: EvaluationResult,
  token?: string,
): { status: 429 | 403; body: DecisionBody | RateLimitBody } | null {
  if (result.action === 'shadow' && result.rateLimited) {
    return {
      status: 429,
      body: {
        error: 'rate_limited',
        message: 'This route is rate limited by the operator’s bot defense policy. The response is not an empty 429.',
        httpStatus: 429,
        decision: 'shadow',
        score: result.score,
        signals: result.signals.filter((s) => s.triggered).map((s) => s.id),
        profileId: result.profileId,
        mode: result.mode,
      },
    };
  }
  if (result.action === 'allow' || result.action === 'flag' || result.action === 'log' || result.action === 'shadow') return null;
  const signals = result.signals.filter((s) => s.triggered).map((s) => s.id);
  if (result.action === 'challenge') {
    return {
      status: 429,
      body: {
        error: 'challenge_required',
        message: 'Visitor check required before this request can continue.',
        httpStatus: 429,
        decision: 'challenge',
        score: result.score,
        signals,
        profileId: result.profileId,
        mode: result.mode,
        token,
      },
    };
  }
  return {
    status: 403,
    body: {
      error: 'request_blocked',
      message: 'This request was blocked by the site operator’s bot defense.',
      httpStatus: 403,
      decision: 'block',
      score: result.score,
      signals,
      profileId: result.profileId,
      mode: result.mode,
    },
  };
}

export function applyDecisionHeaders(set: (name: string, value: string) => void, result: EvaluationResult): void {
  set('X-FCGBDS-Mode', result.mode);
  set('X-FCGBDS-Score', String(result.score));
  set('X-FCGBDS-Decision', result.action);
  set('X-FCGBDS-Intended', result.intendedAction);
  if (result.action === 'shadow') set('X-FCGBDS-Shadow', '1');
  if (result.action === 'flag') set('X-FCGBDS-Flag', '1');
  set('X-FCGBDS-Would-Block', result.wouldHaveBlocked ? '1' : '0');
  set('X-FCGBDS-Would-Challenge', result.wouldHaveChallenged ? '1' : '0');
  set('X-FCGBDS-Profile', result.profileId);
}
