// Docs: docs/architecture/mime-parser-implementation.md
//
// Sentry-style failure aggregation (mime-parser.md §8.0). Groups observations by signature hash in a
// rolling window; fires a report when count ≥ threshold OR distinctSources ≥ M, then leaky-buckets
// that signature so a known failure doesn't re-spam. `distinctSources` is the signal that routes a
// failure to the cold loop (many sources = library bug) vs the hot loop (one source = quirk).

import type { FailureSignature } from './signature.js';

export interface AggregatorOptions {
  /** Rolling window; observations older than this are forgotten. Default 1h. */
  windowMs?: number;
  /** Fire when count reaches this within the window. Default 5. */
  threshold?: number;
  /** Also fire when this many distinct sources are seen (even below `threshold`). Default Infinity. */
  distinctSourcesThreshold?: number;
  /** Don't re-report the same signature within this. Default = windowMs. */
  reportCooldownMs?: number;
  /** Injectable clock (tests). Default Date.now. */
  now?: () => number;
}

export interface FailureReport {
  signature: FailureSignature;
  count: number;
  distinctSources: number;
  firstSeen: number;
  lastSeen: number;
}

interface State {
  count: number;
  firstSeen: number;
  lastSeen: number;
  sources: Set<string>;
  lastReported?: number;
  /** Observation timestamps within the window (for rolling expiry). */
  times: number[];
}

export class FailureAggregator {
  private readonly states = new Map<string, State>();
  private readonly windowMs: number;
  private readonly threshold: number;
  private readonly distinctSourcesThreshold: number;
  private readonly cooldownMs: number;
  private readonly now: () => number;

  constructor(opts: AggregatorOptions = {}) {
    this.windowMs = opts.windowMs ?? 60 * 60 * 1000;
    this.threshold = opts.threshold ?? 5;
    this.distinctSourcesThreshold = opts.distinctSourcesThreshold ?? Infinity;
    this.cooldownMs = opts.reportCooldownMs ?? this.windowMs;
    this.now = opts.now ?? Date.now;
  }

  /**
   * Record one failure occurrence. Returns a FailureReport when the threshold is (re)crossed and the
   * signature is out of cooldown; otherwise null. `source` is a tenant/deployment id for distinctSources.
   */
  observe(signature: FailureSignature, source?: string): FailureReport | null {
    const t = this.now();
    const hash = signature.hash;
    let st = this.states.get(hash);
    if (!st) {
      st = { count: 0, firstSeen: t, lastSeen: t, sources: new Set(), times: [] };
      this.states.set(hash, st);
    }

    // Roll the window: drop observations older than windowMs.
    const cutoff = t - this.windowMs;
    st.times.push(t);
    st.times = st.times.filter((x) => x >= cutoff);
    st.count = st.times.length;
    st.lastSeen = t;
    if (st.firstSeen < cutoff) st.firstSeen = st.times[0] ?? t;
    if (source) st.sources.add(source);

    const overThreshold = st.count >= this.threshold || st.sources.size >= this.distinctSourcesThreshold;
    const outOfCooldown = st.lastReported === undefined || t - st.lastReported >= this.cooldownMs;
    if (overThreshold && outOfCooldown) {
      st.lastReported = t;
      return {
        signature,
        count: st.count,
        distinctSources: st.sources.size,
        firstSeen: st.firstSeen,
        lastSeen: st.lastSeen,
      };
    }
    return null;
  }

  /** Current count for a signature within the window (without observing). */
  countOf(hash: string): number {
    const st = this.states.get(hash);
    if (!st) return 0;
    const cutoff = this.now() - this.windowMs;
    return st.times.filter((x) => x >= cutoff).length;
  }
}
