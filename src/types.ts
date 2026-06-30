// Docs: docs/architecture/mime-parser-implementation.md
//
// @generated-pending — these data models are hand-written for Phase 1. The JTD SSOT
// (schema/models/*.jtd.json → gen/<lang>/, Phase 0) will own them; keep this file in
// sync until codegen replaces it. See mime-parser.md §5.

/** A parsed email address. Full RFC 5322 group/comment handling is a Phase 1 follow-up. */
export interface Address {
  /** The addr-spec, e.g. "user@example.com". Empty string if unparseable. */
  address: string;
  /** The display name, if present (RFC 2047 decoded). */
  name?: string;
}

/** A raw header line, in document order. `key` is the field name as written; `value` is unfolded. */
export interface Header {
  key: string;
  value: string;
}

/**
 * Where a parse degradation occurred. This `scope` is the same taxonomy the failure-signature
 * primitive uses (mime-parser.md §8.0) — envelope (headers), structure (multipart assembly),
 * or part (one leaf).
 */
export type DiagnosticScope = 'envelope' | 'structure' | 'part';

/** A typed, non-fatal degradation. The parser collects these instead of throwing. */
export interface Diagnostic {
  /** Stable machine code, e.g. "UNKNOWN_CHARSET", "BOUNDARY_NOT_CLOSED". */
  code: string;
  severity: 'warn' | 'error';
  scope: DiagnosticScope;
  /** Human detail; never contains raw body content. */
  detail?: string;
  /** Structural path to the offending part, e.g. "multipart/mixed>application/pdf". */
  path?: string;
}

/** A decoded attachment (or inline) part. */
export interface Attachment {
  filename: string | null;
  /** Lowercased "type/subtype". */
  mimeType: string;
  disposition: 'attachment' | 'inline' | null;
  contentId: string | null;
  /** Decoded bytes. The streaming API exposes these as a stream instead of buffering. */
  content: Uint8Array;
  size: number;
}

/** The parsed message — the convenience (buffered) result of `parse()`. */
export interface Message {
  headers: Header[];
  from?: Address;
  to: Address[];
  cc: Address[];
  bcc: Address[];
  replyTo: Address[];
  subject: string | null;
  messageId: string | null;
  inReplyTo: string | null;
  /** Raw Date header value (unparsed); date parsing is a follow-up. */
  date: string | null;
  /** Concatenated text/plain bodies (decoded). */
  text: string | null;
  /** Concatenated text/html bodies (decoded). */
  html: string | null;
  attachments: Attachment[];
  diagnostics: Diagnostic[];
  /** Merged middleware annotations (e.g. detected language). Empty when no middleware ran. */
  annotations: Record<string, unknown>;
}

/**
 * The structural metadata the core computes for every MIME node BEFORE middleware runs
 * (mime-parser.md §4, "Layer 0"). Middleware match against this; it never re-discovers structure.
 */
export interface PartMeta {
  /** Depth in the MIME tree (0 = root). */
  depth: number;
  headers: Header[];
  /** Lowercased "type/subtype"; defaults to "text/plain" per RFC 2045. */
  contentType: string;
  /** Lowercased main type, e.g. "multipart", "text", "image". */
  mainType: string;
  charset?: string;
  /** Content-Type `format` param (e.g. "flowed", RFC 3676). */
  format?: string;
  /** Content-Type `delsp` param === "yes". */
  delsp?: boolean;
  /** Lowercased Content-Transfer-Encoding; defaults to "7bit". */
  encoding: string;
  disposition?: 'attachment' | 'inline';
  filename?: string;
  contentId?: string;
  /** The multipart boundary, if this node is a multipart container. */
  boundary?: string;
  isMultipart: boolean;
  /** "multipart/mixed>application/pdf" — the content-type path from the root. */
  path: string;
}
