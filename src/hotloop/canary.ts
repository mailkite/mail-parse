// Docs: docs/architecture/hot-loop-scoping.md
//
// Canary rollout state machine (hot-loop sub-phases 6.5/6.6, pure logic). An approved middleware never
// jumps straight to serving all traffic: it graduates shadow → 5% → 25% → 100%, advancing only while
// parse-success holds (Δ ≥ 0) and errors stay at zero, and auto-rolling-back to `disabled` on any
// regression. The kill switch is one transition to `disabled`. This is a pure reducer — the platform
// feeds it real metrics per round and persists the state (e.g. in the signed manifest, §4.3).

export type CanaryStage = 'shadow' | 'canary_5' | 'canary_25' | 'live_100' | 'disabled';

const ORDER: CanaryStage[] = ['shadow', 'canary_5', 'canary_25', 'live_100'];

export interface CanaryState {
  stage: CanaryStage;
  /** Consecutive healthy rounds observed at the current stage. */
  healthyRounds: number;
}

export interface RolloutMetrics {
  /** Change in parse-success rate vs the incumbent, over the round. Negative = regression. */
  parseSuccessDelta: number;
  /** Hard errors attributed to the candidate this round. */
  errors: number;
}

export interface RolloutPolicy {
  /** Healthy rounds required at a stage before advancing. Default 1. Raise it to widen the canary slower. */
  promoteAfterHealthyRounds?: number;
}

/** Fraction of live traffic a stage serves. `shadow` observes only (0); `disabled` serves nothing. */
export function trafficFraction(stage: CanaryStage): number {
  switch (stage) {
    case 'canary_5':
      return 0.05;
    case 'canary_25':
      return 0.25;
    case 'live_100':
      return 1;
    default:
      return 0; // shadow + disabled
  }
}

/** A freshly-approved candidate starts in shadow (observe-only). */
export function initialCanary(): CanaryState {
  return { stage: 'shadow', healthyRounds: 0 };
}

/** The kill switch / auto-rollback terminal state. */
export function disabled(): CanaryState {
  return { stage: 'disabled', healthyRounds: 0 };
}

/**
 * Reduce one round of metrics into the next state. Any regression (error, or success Δ < 0) trips an
 * immediate rollback to `disabled`. Otherwise the candidate accrues healthy rounds and advances a stage
 * once it has enough. `disabled` and `live_100` are terminal for this reducer.
 */
export function advanceCanary(
  state: CanaryState,
  metrics: RolloutMetrics,
  policy: RolloutPolicy = {},
): CanaryState {
  if (state.stage === 'disabled') return state;
  if (metrics.errors > 0 || metrics.parseSuccessDelta < 0) return disabled(); // auto-rollback

  const healthy = state.healthyRounds + 1;
  const need = policy.promoteAfterHealthyRounds ?? 1;
  if (state.stage === 'live_100') return { stage: 'live_100', healthyRounds: healthy };
  if (healthy < need) return { stage: state.stage, healthyRounds: healthy };

  const next = ORDER[ORDER.indexOf(state.stage) + 1]!;
  return { stage: next, healthyRounds: 0 };
}
