// Docs: docs/architecture/mime-parser-implementation.md
//
// Streaming parse (Phase 1 follow-up): drive the splitter and hand each leaf's DECODED body out chunk by
// chunk, so a caller can pipe a large attachment straight to a sink (R2, disk, a hash) without ever
// buffering the whole part. `parse()` is the buffered convenience layer; this is the primitive underneath
// it for the memory-bounded path (the MX-edge → R2 use case in attachments-r2.md).
//
// The splitter already streams RAW body bytes via onBody; the missing piece was a per-leaf streaming
// transfer-decode (base64/QP across chunk boundaries) — see stream-decode.ts.

import { createTransferDecoder, type StreamingDecoder } from './stream-decode.js';
import { splitMime } from './splitter.js';
import type { ByteSource } from './line-reader.js';
import type { Diagnostic, PartMeta } from './types.js';

export interface StreamHandlers {
  /** A node's headers are parsed; PartMeta is known. Fires for containers and leaves. */
  onNodeStart?(meta: PartMeta): void;
  /** A chunk of DECODED (transfer-decoded) body bytes for a leaf. Fires zero or more times. */
  onBodyChunk?(meta: PartMeta, decoded: Uint8Array): void;
  /** A leaf's body is fully delivered (all decoded chunks emitted), or a container closed. */
  onNodeEnd?(meta: PartMeta): void;
  /** A non-fatal structural degradation. */
  onDiagnostic?(d: Diagnostic): void;
}

/**
 * Parse `source`, streaming each leaf's decoded body to `handlers.onBodyChunk`. Memory stays bounded to
 * the splitter's one-line window plus the decoder's tiny carry — the full part is never held. Never throws
 * on malformed input (degradations arrive via onDiagnostic).
 *
 * Granularity note: the splitter is line-oriented, so a leaf is streamed one *body line* at a time. Real
 * MIME wraps base64/QP at ~76 columns (RFC 2045), so this streams in small steps. A pathologically
 * *unwrapped* single-line body (e.g. Node's `Buffer.toString('base64')`, which omits wrapping) is still
 * buffered as one line by the reader — chunking below a line is a deeper follow-up, not needed for
 * standards-compliant mail.
 */
export async function parseStream(source: ByteSource, handlers: StreamHandlers): Promise<void> {
  let decoder: StreamingDecoder | null = null;

  await splitMime(source, {
    onNodeStart(meta) {
      handlers.onNodeStart?.(meta);
      // Leaves get a fresh per-part decoder; containers (multipart) never carry a body.
      decoder = meta.isMultipart ? null : createTransferDecoder(meta.encoding);
    },
    onBody(meta, rawChunk) {
      if (!decoder) return;
      const decoded = decoder.push(rawChunk);
      if (decoded.length) handlers.onBodyChunk?.(meta, decoded);
    },
    onNodeEnd(meta) {
      if (decoder) {
        const tail = decoder.flush();
        if (tail.length) handlers.onBodyChunk?.(meta, tail);
        decoder = null;
      }
      handlers.onNodeEnd?.(meta);
    },
    onDiagnostic(d) {
      handlers.onDiagnostic?.(d);
    },
  });
}
