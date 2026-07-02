// Docs: docs/architecture/hot-loop-scoping.md
//
// Sealed failure fixtures + replay (hot-loop sub-phase 6.1, library half). A sealed fixture is the raw
// bytes that triggered a parse failure, plus the failure signature that grouped it and the diagnostic
// codes it produced. It's the reproducible unit the gates (gates.ts) and — later — the generation agent
// consume: "here is the exact message that broke; prove your fix resolves it and nothing else."
//
// PII note: `raw` is the sensitive part. In production these fixtures are stored redacted + TTL'd in R2
// (hot-loop-scoping §2). This library model just carries the bytes for in-process replay — the trigger
// that reaches an LLM is the PII-free *signature*, never the raw message.

import { parse } from '../parse.js';
import type { Middleware } from '../middleware.js';
import type { Diagnostic, Message } from '../types.js';

/** A reproducible parse failure: the raw message + how it failed. */
export interface SealedFixture {
  /** Stable id (e.g. the signature hash + a counter). */
  id: string;
  /** Raw message bytes that triggered the failure (PII-bearing; redacted at rest in prod). */
  raw: Uint8Array;
  /** The PII-free failure-signature hash that grouped this failure. */
  signature: string;
  /** The diagnostic codes the reference parser produced on this message — the failure to resolve. */
  failingCodes: string[];
  /** Optional human note (never re-derived from body content). */
  note?: string;
}

/** The result of parsing a fixture (optionally with a candidate middleware applied). */
export interface ReplayResult {
  message: Message;
  diagnostics: Diagnostic[];
  codes: string[];
}

/** Parse `raw` (optionally through one candidate middleware) and surface its diagnostic codes. */
export async function replay(raw: Uint8Array, candidate?: Middleware): Promise<ReplayResult> {
  const message = await parse(raw, candidate ? { middleware: [candidate] } : {});
  const codes = message.diagnostics.map((d) => d.code);
  return { message, diagnostics: message.diagnostics, codes };
}

/** Build a sealed fixture from raw bytes, capturing the codes the reference parser currently emits. */
export async function sealFixture(
  id: string,
  raw: Uint8Array,
  signature: string,
  note?: string,
): Promise<SealedFixture> {
  const { codes } = await replay(raw);
  return { id, raw, signature, failingCodes: codes, ...(note ? { note } : {}) };
}
