import type { EvaluationResult } from './types';

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

/** Explicit challenge (429) or block (403). Callers must send `body`; an empty 429 is not used. */
export function decisionFor(result: EvaluationResult, token?: string): { status: 429 | 403; body: DecisionBody } | null {
  if (result.action === 'allow') return null;
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
  set('X-FCGBDS-Would-Block', result.wouldHaveBlocked ? '1' : '0');
  set('X-FCGBDS-Would-Challenge', result.wouldHaveChallenged ? '1' : '0');
  set('X-FCGBDS-Profile', result.profileId);
}
