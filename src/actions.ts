import type { DecisionAction, RouteProfile } from './types';

const ORDER: DecisionAction[] = ['allow', 'log', 'flag', 'shadow', 'challenge', 'block'];

export function resolveIntendedAction(
  score: number,
  profile: RouteProfile,
  defaults: { challengeThreshold: number; blockThreshold: number },
): DecisionAction {
  if (profile.actionRules?.length) {
    const match = [...profile.actionRules]
      .filter((rule) => score >= rule.minScore && ORDER.includes(rule.action))
      .sort((a, b) => b.minScore - a.minScore)[0];
    return match?.action || 'allow';
  }
  const blockAt = profile.blockThreshold ?? defaults.blockThreshold;
  const challengeAt = profile.challengeThreshold ?? defaults.challengeThreshold;
  if (score >= blockAt) return 'block';
  if (score >= challengeAt) return 'challenge';
  return 'allow';
}
