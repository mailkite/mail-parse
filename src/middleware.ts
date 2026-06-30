// Docs: docs/architecture/mime-parser-implementation.md
//
// The middleware registry (mime-parser.md §4). Declarative-match dispatch (most-specific-first) +
// a scoped (part, next) micro-chain. The core computes PartMeta first (Layer 0, see splitter.ts);
// middleware then runs per classified part. A middleware transforms the part, sets a text/html
// channel, reclassifies, emits replacement parts, or no-ops — and calls next() to continue or
// returns without it to short-circuit (the php-mime-mail-parser contract). A throwing middleware
// is contained: its error becomes a diagnostic and the chain recovers (injected-tolerance default).

import { matches, specificity, type MatchSpec } from './match.js';
import type { TraceHook } from './trace.js';
import type { Diagnostic, PartMeta } from './types.js';

/** Fixed pipeline phases (mime-parser.md §4). Middleware run in this order. */
export type Phase = 'ingest' | 'normalize' | 'decode' | 'structure' | 'extract' | 'enrich';
const PHASE_ORDER: readonly Phase[] = ['ingest', 'normalize', 'decode', 'structure', 'extract', 'enrich'];

export interface Middleware {
  name: string;
  phase: Phase;
  match: MatchSpec;
  /** Reserved for topological ordering within a phase; v1 orders by specificity then insertion. */
  order?: { runAfter?: string[]; runBefore?: string[] };
  onPart(part: Part, next: () => Promise<void>): void | Promise<void>;
}

/** A part a middleware emits in place of (or in addition to) the one it received. */
export interface EmittedPart {
  meta: PartMeta;
  body: Uint8Array;
}

/** The mutable per-part handle middleware operate on. */
export class Part {
  /** Set to claim this part as a decoded text channel. */
  text?: string;
  /** Set to claim this part as a decoded html channel. */
  html?: string;
  /** Force classification, overriding the default text/attachment decision. */
  classifyAs?: 'attachment' | 'text' | 'html';
  /** Replacement/extra parts (e.g. a container decode). If non-empty, these replace this part. */
  readonly emitted: EmittedPart[] = [];
  /** Scratch space shared across the chain for this part; merged into Message.annotations. */
  readonly context: Record<string, unknown> = {};
  readonly diagnostics: Diagnostic[] = [];

  constructor(
    readonly meta: PartMeta,
    public body: Uint8Array,
  ) {}

  addDiagnostic(d: Diagnostic): void {
    this.diagnostics.push(d);
  }
}

export class Registry {
  private readonly mws: Middleware[] = [];

  use(mw: Middleware): this {
    this.mws.push(mw);
    return this;
  }

  get size(): number {
    return this.mws.length;
  }

  /** Middleware matched for a part, ordered by phase → specificity (desc) → insertion. */
  private resolve(part: Part): Middleware[] {
    return this.mws
      .map((mw, idx) => ({ mw, idx }))
      .filter(({ mw }) => matches(mw.match, part.meta, part.body))
      .sort((a, b) => {
        const dp = PHASE_ORDER.indexOf(a.mw.phase) - PHASE_ORDER.indexOf(b.mw.phase);
        if (dp !== 0) return dp;
        const ds = specificity(b.mw.match) - specificity(a.mw.match);
        if (ds !== 0) return ds;
        return a.idx - b.idx;
      })
      .map((m) => m.mw);
  }

  /** Run the matched (part, next) chain. Tolerant: a throwing middleware is contained + recovered. */
  async runPart(part: Part, trace?: TraceHook): Promise<void> {
    const chain = this.resolve(part);
    const run = async (i: number): Promise<void> => {
      if (i >= chain.length) return;
      const mw = chain[i]!;
      let advanced = false;
      const next = async (): Promise<void> => {
        if (advanced) return; // next() is idempotent within a frame
        advanced = true;
        await run(i + 1);
      };
      const span = trace?.start(mw.name, part.meta);
      const inSize = part.body.length;
      try {
        await mw.onPart(part, next);
        span?.end({ inSize, outSize: part.body.length, status: 'ok' });
      } catch (e) {
        const message = e instanceof Error ? e.message : String(e);
        part.addDiagnostic({
          code: 'MIDDLEWARE_ERROR',
          severity: 'warn',
          scope: 'part',
          path: part.meta.path,
          detail: `${mw.name}: ${message}`,
        });
        span?.end({ inSize, outSize: part.body.length, status: 'error', error: message });
        if (!advanced) await run(i + 1); // recover by continuing the chain
      }
    };
    await run(0);
  }
}

/** Normalize the `middleware` option into a Registry, or null when there's nothing to run. */
export function toRegistry(m: Middleware[] | Registry | undefined): Registry | null {
  if (!m) return null;
  if (m instanceof Registry) return m.size ? m : null;
  if (Array.isArray(m)) {
    if (m.length === 0) return null;
    const r = new Registry();
    for (const mw of m) r.use(mw);
    return r;
  }
  return null;
}
