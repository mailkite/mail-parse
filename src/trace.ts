// Docs: docs/architecture/mime-parser-implementation.md
//
// Per-middleware tracing hook (mime-parser.md §6). The registry calls start()/end() around every
// middleware invocation so the in/out state at each level is observable — the substrate the
// cold-loop issue body and (later) the hot-loop fix loop consume. This is a minimal in-process
// shape; an OTLP exporter is a thin adapter over the same SpanRecord.

import type { PartMeta } from './types.js';

export interface SpanEnd {
  inSize: number;
  outSize: number;
  status: 'ok' | 'error';
  error?: string;
}

export interface Span {
  end(info: SpanEnd): void;
}

export interface TraceHook {
  start(mwName: string, meta: PartMeta): Span | undefined;
}

export interface SpanRecord extends SpanEnd {
  mw: string;
  path: string;
}

/** A simple collector — one record per middleware invocation, in START order (parent before child). */
export class ArrayTrace implements TraceHook {
  readonly spans: SpanRecord[] = [];
  start(mw: string, meta: PartMeta): Span {
    // Push at start so spans appear in invocation order; end() fills in the in/out + status.
    const rec: SpanRecord = { mw, path: meta.path, inSize: 0, outSize: 0, status: 'ok' };
    this.spans.push(rec);
    return { end: (info: SpanEnd) => Object.assign(rec, info) };
  }
}
