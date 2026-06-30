// Docs: docs/architecture/mime-parser-implementation.md
//
// Declarative match for the middleware registry (mime-parser.md §4). A match is DATA, not code
// (except the explicit `predicate` escape hatch), so it ports across languages and can later be
// scored/validated by the hot-loop guardrails (§9). `specificity` drives "most-specific-first"
// ordering and the future generated-middleware floor.

import type { PartMeta } from './types.js';

/** A declarative predicate over a part's structural metadata (+ optional body byte-signature). */
export interface MatchSpec {
  /** Exact "type/subtype", e.g. "application/pdf" (most specific). */
  contentType?: string;
  /** Main type, e.g. "text", "image", "multipart". */
  maintype?: string;
  charset?: string;
  disposition?: 'inline' | 'attachment';
  /** Match the part's filename. */
  filename?: RegExp;
  /** Match a header value (case-insensitive name). */
  header?: { name: string; matches: RegExp };
  /** Magic-number match on the decoded body's leading bytes. */
  byteSignature?: { offset: number; hexPrefix: string };
  /** Escape hatch — an arbitrary predicate. Keep it narrow; it can't be statically scored well. */
  predicate?: (meta: PartMeta, body: Uint8Array) => boolean;
}

const WEIGHTS = {
  contentType: 1.0,
  byteSignature: 0.9,
  header: 0.6,
  filename: 0.5,
  predicate: 0.5,
  charset: 0.4,
  disposition: 0.3,
  maintype: 0.2,
} as const;

/** Does `spec` match this part? All present fields must match (AND). */
export function matches(spec: MatchSpec, meta: PartMeta, body: Uint8Array): boolean {
  if (spec.contentType !== undefined && spec.contentType.toLowerCase() !== meta.contentType) return false;
  if (spec.maintype !== undefined && spec.maintype.toLowerCase() !== meta.mainType) return false;
  if (spec.charset !== undefined && spec.charset.toLowerCase() !== (meta.charset ?? '').toLowerCase()) return false;
  if (spec.disposition !== undefined && spec.disposition !== meta.disposition) return false;
  if (spec.filename !== undefined && !(meta.filename && spec.filename.test(meta.filename))) return false;
  if (spec.header !== undefined) {
    const lower = spec.header.name.toLowerCase();
    const h = meta.headers.find((x) => x.key.toLowerCase() === lower);
    if (!h || !spec.header.matches.test(h.value)) return false;
  }
  if (spec.byteSignature !== undefined && !matchesByteSignature(spec.byteSignature, body)) return false;
  if (spec.predicate !== undefined && !spec.predicate(meta, body)) return false;
  return true;
}

function matchesByteSignature(sig: { offset: number; hexPrefix: string }, body: Uint8Array): boolean {
  const hex = sig.hexPrefix.toLowerCase().replace(/[^0-9a-f]/g, '');
  const nbytes = hex.length >> 1;
  if (body.length < sig.offset + nbytes) return false;
  for (let i = 0; i < nbytes; i++) {
    const want = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
    if (body[sig.offset + i] !== want) return false;
  }
  return true;
}

/**
 * A specificity score in [0,1] — more (and more selective) conjuncts → higher. Used to order
 * competing middleware in the same phase and, later, to gate over-broad generated matches (§9).
 */
export function specificity(spec: MatchSpec): number {
  let score = 0;
  for (const [k, w] of Object.entries(WEIGHTS)) {
    if (spec[k as keyof MatchSpec] !== undefined) score += w;
  }
  // Saturate to [0,1]: a couple of strong conjuncts already approach 1.
  return Math.min(1, score / 2);
}
