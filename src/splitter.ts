// Docs: docs/architecture/mime-parser-implementation.md
//
// The streaming MIME splitter — the mailsplit-model boundary state machine (mime-parser.md §3/§4).
// Byte chunks in → structured node events out. It holds at most ONE part's worth of state in flight
// (and within a part, only a single line is buffered, to honor the "CRLF before a boundary belongs to
// the boundary" rule, RFC 2046 §5.1.1). This is "Layer 0": it computes each node's PartMeta BEFORE any
// middleware sees it, so middleware is always part-scoped (mime-parser.md §4, "two layers").

import { bytesToLatin1, decodeCharset } from './decode.js';
import {
  decodeEncodedWords,
  getHeader,
  parseHeaderBlock,
  parseStructuredField,
} from './headers.js';
import { readLines, type ByteSource, type Line } from './line-reader.js';
import type { Diagnostic, Header, PartMeta } from './types.js';

export interface SplitHandlers {
  /** Headers complete; PartMeta computed. Fires for every node (containers + leaves). */
  onNodeStart?(meta: PartMeta): void;
  /** A chunk of RAW (still transfer-encoded) body bytes for a leaf node. May fire many times. */
  onBody?(meta: PartMeta, chunk: Uint8Array): void;
  /** Node finished (leaf body fully delivered, or container closed). */
  onNodeEnd?(meta: PartMeta): void;
  /** A non-fatal structural degradation. */
  onDiagnostic?(d: Diagnostic): void;
}

interface MultipartCtx {
  boundary: string;
  depth: number;
  meta: PartMeta;
  closed: boolean;
}

const DASH = 0x2d;

/** Drive the state machine over a byte source, emitting node events to `handlers`. */
export async function splitMime(source: ByteSource, handlers: SplitHandlers): Promise<void> {
  const stack: MultipartCtx[] = [];
  let mode: 'headers' | 'body' | 'scan' = 'headers';
  let headerLines: Line[] = [];
  let curDepth = 0;
  let parentPath = '';
  let leaf: { meta: PartMeta } | null = null;
  let pending: Line | null = null; // the most recent body line, held back until we know it isn't last

  const flushPending = (dropTerm: boolean) => {
    if (!pending || !leaf) return;
    if (pending.bytes.length) handlers.onBody?.(leaf.meta, pending.bytes);
    if (!dropTerm && pending.term) handlers.onBody?.(leaf.meta, termBytes(pending.term));
    pending = null;
  };

  const closeLeaf = (byBoundary: boolean) => {
    if (!leaf) return;
    flushPending(byBoundary); // CRLF before a boundary is part of the boundary, not the body
    handlers.onNodeEnd?.(leaf.meta);
    leaf = null;
  };

  // Returns the next mode + leaf. Both assignments happen in the main loop (not inside this
  // closure) so control-flow analysis sees them — otherwise TS narrows `mode`/`leaf` to exclude
  // the values only ever assigned inside a closure.
  const finishHeaders = (): { mode: 'body' | 'scan'; leaf: { meta: PartMeta } | null } => {
    const meta = computeMeta(headerLines, curDepth, parentPath);
    headerLines = [];
    handlers.onNodeStart?.(meta);
    if (meta.isMultipart && meta.boundary) {
      stack.push({ boundary: meta.boundary, depth: curDepth, meta, closed: false });
      return { mode: 'scan', leaf: null };
    }
    pending = null;
    return { mode: 'body', leaf: { meta } };
  };

  for await (const line of readLines(source)) {
    if (mode === 'headers') {
      if (line.bytes.length === 0) {
        const r = finishHeaders();
        mode = r.mode;
        leaf = r.leaf;
      } else {
        headerLines.push(line);
      }
      continue;
    }

    const delim = matchBoundary(line, stack);
    if (delim) {
      closeLeaf(true);
      // Pop any inner contexts left unclosed by a missing close-delimiter (tolerant).
      while (stack.length && stack[stack.length - 1]!.depth > delim.ctx.depth) {
        const orphan = stack.pop()!;
        handlers.onDiagnostic?.({
          code: 'BOUNDARY_NOT_CLOSED',
          severity: 'warn',
          scope: 'structure',
          path: orphan.meta.path,
          detail: `multipart boundary "${orphan.boundary}" was never closed`,
        });
        handlers.onNodeEnd?.(orphan.meta);
      }
      if (delim.kind === 'start') {
        curDepth = delim.ctx.depth + 1;
        parentPath = delim.ctx.meta.path;
        headerLines = [];
        mode = 'headers';
      } else {
        delim.ctx.closed = true;
        const closed = stack.pop();
        if (closed) handlers.onNodeEnd?.(closed.meta);
        mode = 'scan'; // remaining lines belong to the parent (epilogue) until its boundary
      }
      continue;
    }

    if (mode === 'body' && leaf) {
      if (pending) {
        if (pending.bytes.length) handlers.onBody?.(leaf.meta, pending.bytes);
        if (pending.term) handlers.onBody?.(leaf.meta, termBytes(pending.term));
      }
      pending = line;
    }
    // mode === 'scan' → preamble/epilogue, ignored
  }

  // EOF — a node whose headers run to EOF without a terminating blank line still counts
  // (header-only message, or a final multipart part with no trailing blank line).
  if (mode === 'headers' && headerLines.length) {
    const r = finishHeaders();
    mode = r.mode;
    leaf = r.leaf;
  }
  // Close whatever's open.
  closeLeaf(false);
  while (stack.length) {
    const orphan = stack.pop()!;
    if (!orphan.closed) {
      handlers.onDiagnostic?.({
        code: 'BOUNDARY_NOT_CLOSED',
        severity: 'warn',
        scope: 'structure',
        path: orphan.meta.path,
        detail: `multipart boundary "${orphan.boundary}" was never closed (EOF)`,
      });
      handlers.onNodeEnd?.(orphan.meta);
    }
  }
}

interface BoundaryHit {
  ctx: MultipartCtx;
  kind: 'start' | 'end';
}

/** Match a line against the boundary stack, innermost first. Returns the closest match or null. */
function matchBoundary(line: Line, stack: MultipartCtx[]): BoundaryHit | null {
  if (line.bytes.length < 2 || line.bytes[0] !== DASH || line.bytes[1] !== DASH) return null;
  const content = bytesToLatin1(line.bytes).replace(/[ \t]+$/, '');
  for (let i = stack.length - 1; i >= 0; i--) {
    const ctx = stack[i]!;
    if (content === `--${ctx.boundary}--`) return { ctx, kind: 'end' };
    if (content === `--${ctx.boundary}`) return { ctx, kind: 'start' };
  }
  return null;
}

/** Compute the structural metadata for a node from its raw header lines. */
function computeMeta(headerLines: Line[], depth: number, parentPath: string): PartMeta {
  const block = headerLines.map((l) => bytesToLatin1(l.bytes)).join('\n');
  const headers: Header[] = parseHeaderBlock(block);

  const ctRaw = getHeader(headers, 'content-type');
  const ct = ctRaw ? parseStructuredField(ctRaw) : { value: 'text/plain', params: {} };
  const contentType = ct.value || 'text/plain';
  const mainType = contentType.split('/')[0] ?? 'text';
  const boundary = ct.params['boundary'];
  const isMultipart = mainType === 'multipart' && !!boundary;

  const encoding = (getHeader(headers, 'content-transfer-encoding') ?? '7bit').toLowerCase().trim();

  const cdRaw = getHeader(headers, 'content-disposition');
  const cd = cdRaw ? parseStructuredField(cdRaw) : undefined;
  const disposition =
    cd?.value === 'attachment' || cd?.value === 'inline' ? cd.value : undefined;

  const rawName = cd?.params['filename'] ?? ct.params['name'];
  const filename = rawName ? decodeEncodedWords(rawName) : undefined;

  const cid = getHeader(headers, 'content-id')?.replace(/^<|>$/g, '');
  const charset = ct.params['charset'];
  const format = ct.params['format'];
  const delsp = ct.params['delsp']?.toLowerCase() === 'yes';

  const path = parentPath ? `${parentPath}>${contentType}` : contentType;

  return {
    depth,
    headers,
    contentType,
    mainType,
    ...(charset ? { charset } : {}),
    ...(format ? { format } : {}),
    ...(delsp ? { delsp } : {}),
    encoding,
    ...(disposition ? { disposition } : {}),
    ...(filename ? { filename } : {}),
    ...(cid ? { contentId: cid } : {}),
    ...(boundary ? { boundary } : {}),
    isMultipart,
    path,
  };
}

function termBytes(term: '\r\n' | '\n' | ''): Uint8Array {
  return term === '\r\n' ? Uint8Array.of(0x0d, 0x0a) : term === '\n' ? Uint8Array.of(0x0a) : new Uint8Array(0);
}

// Re-export for callers that want to decode a charset against a node's declared charset.
export { decodeCharset };
