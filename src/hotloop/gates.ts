// Docs: docs/architecture/hot-loop-scoping.md
//
// The gate battery (hot-loop sub-phase 6.4) — the crux of the whole design: a generated middleware is
// auto-approved ONLY by passing these *system-owned adversarial gates the AI never authors*. "The tests
// pass" is meaningless if the AI wrote the tests; here the corpus is the judge, the candidate is the
// defendant. Every gate is a pure function over the candidate + the fixtures/corpus — no LLM, no network,
// no ambient authority.
//
// Gates (all must pass):
//   1. specificity floor   — the match must be selective enough (reuses match.ts specificity()).
//   2. benign-corpus zero-fire — the predicate must NOT fire on any known-healthy message (the load-
//      bearing gate: it's what stops an over-broad fix from corrupting good traffic).
//   3. golden-from-fixture — it must actually resolve the sealed failing case.
//   4. identity replay     — it must not change the output of any healthy message (no-op off-target).

import { decodeTransfer } from '../decode.js';
import { matches, specificity } from '../match.js';
import type { Middleware } from '../middleware.js';
import { parse } from '../parse.js';
import { splitMime } from '../splitter.js';
import type { Message, PartMeta } from '../types.js';
import { replay, type SealedFixture } from './fixture.js';

/** A known-healthy message the candidate must leave untouched. */
export interface BenignSample {
  id: string;
  raw: Uint8Array;
}

export interface GateResult {
  gate: 'specificity' | 'benign-zero-fire' | 'golden' | 'identity';
  passed: boolean;
  detail?: string;
}

export interface CandidateVerdict {
  /** True only if every gate passed — this is the auto-approval signal. */
  approved: boolean;
  results: GateResult[];
}

export interface GateOptions {
  fixture: SealedFixture;
  benignCorpus: BenignSample[];
  /** Minimum specificity in [0,1]; generated middleware must be at least this narrow. Default 0.5. */
  minSpecificity?: number;
}

/** Collect each leaf's (meta, decoded body) — what the registry actually matches middleware against. */
async function leaves(raw: Uint8Array): Promise<{ meta: PartMeta; body: Uint8Array }[]> {
  const open = new Map<PartMeta, Uint8Array[]>();
  const out: { meta: PartMeta; body: Uint8Array }[] = [];
  await splitMime(raw, {
    onNodeStart(meta) {
      if (!meta.isMultipart) open.set(meta, []);
    },
    onBody(meta, chunk) {
      open.get(meta)?.push(chunk);
    },
    onNodeEnd(meta) {
      const chunks = open.get(meta);
      if (!chunks) return;
      open.delete(meta);
      const total = chunks.reduce((n, c) => n + c.length, 0);
      const raw2 = new Uint8Array(total);
      let off = 0;
      for (const c of chunks) {
        raw2.set(c, off);
        off += c.length;
      }
      out.push({ meta, body: decodeTransfer(raw2, meta.encoding) });
    },
  });
  return out;
}

/** Does the candidate's match fire on any leaf of this message? */
async function firesOn(mw: Middleware, raw: Uint8Array): Promise<boolean> {
  for (const { meta, body } of await leaves(raw)) {
    if (matches(mw.match, meta, body)) return true;
  }
  return false;
}

/** A content-comparable projection of a parsed message (ignores object identity / ordering-neutral). */
function shape(m: Message): string {
  return JSON.stringify({
    text: m.text,
    html: m.html,
    attachments: m.attachments.map((a) => ({ f: a.filename, t: a.mimeType, s: a.size })),
  });
}

/** Gate 1 — specificity floor. */
export function gateSpecificity(mw: Middleware, min: number): GateResult {
  const s = specificity(mw.match);
  return {
    gate: 'specificity',
    passed: s >= min,
    detail: `specificity ${s.toFixed(2)} ${s >= min ? '>=' : '<'} floor ${min.toFixed(2)}`,
  };
}

/** Gate 2 — the predicate must not fire on any benign sample. */
export async function gateBenignZeroFire(
  mw: Middleware,
  corpus: BenignSample[],
): Promise<GateResult> {
  for (const sample of corpus) {
    if (await firesOn(mw, sample.raw)) {
      return { gate: 'benign-zero-fire', passed: false, detail: `fired on benign sample "${sample.id}"` };
    }
  }
  return { gate: 'benign-zero-fire', passed: true, detail: `clean over ${corpus.length} benign samples` };
}

/** Gate 3 — the candidate must resolve the fixture's failing codes without introducing an error. */
export async function gateGolden(mw: Middleware, fixture: SealedFixture): Promise<GateResult> {
  const after = await replay(fixture.raw, mw);
  const stillFailing = fixture.failingCodes.filter((c) => after.codes.includes(c));
  if (stillFailing.length) {
    return { gate: 'golden', passed: false, detail: `did not resolve: ${stillFailing.join(', ')}` };
  }
  const newErrors = after.diagnostics.filter(
    (d) => d.severity === 'error' && !fixture.failingCodes.includes(d.code),
  );
  if (newErrors.length) {
    return { gate: 'golden', passed: false, detail: `introduced error: ${newErrors[0]!.code}` };
  }
  return { gate: 'golden', passed: true, detail: `resolved ${fixture.failingCodes.join(', ') || '(no codes)'}` };
}

/** Gate 4 — the candidate must be a no-op on every benign sample (output byte-identical with/without it). */
export async function gateIdentity(mw: Middleware, corpus: BenignSample[]): Promise<GateResult> {
  for (const sample of corpus) {
    const base = shape(await parse(sample.raw));
    const withMw = shape(await parse(sample.raw, { middleware: [mw] }));
    if (base !== withMw) {
      return { gate: 'identity', passed: false, detail: `changed output of benign sample "${sample.id}"` };
    }
  }
  return { gate: 'identity', passed: true, detail: `no-op over ${corpus.length} benign samples` };
}

/**
 * Run the full gate battery. `approved` is true only if EVERY gate passes — that boolean is the sole
 * auto-approval authority for a generated middleware. No gate here is authored by the candidate's author.
 */
export async function evaluateCandidate(
  mw: Middleware,
  opts: GateOptions,
): Promise<CandidateVerdict> {
  const min = opts.minSpecificity ?? 0.5;
  const results: GateResult[] = [
    gateSpecificity(mw, min),
    await gateBenignZeroFire(mw, opts.benignCorpus),
    await gateGolden(mw, opts.fixture),
    await gateIdentity(mw, opts.benignCorpus),
  ];
  return { approved: results.every((r) => r.passed), results };
}
