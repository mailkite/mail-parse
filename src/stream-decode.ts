// Docs: docs/architecture/mime-parser-implementation.md
//
// Streaming transfer-decoders (Phase 1 follow-up: stream attachment bodies to a sink without buffering
// the whole part — see attachments-r2.md). The buffered `decodeTransfer` needs the entire part in memory;
// these decode incrementally, carrying only the small remainder that can't be resolved until the next
// chunk arrives (a base64 quad boundary, a split `=XX` escape, or a `=\r\n` soft break). Output is
// byte-for-byte identical to the buffered path — asserted in test/stream.test.ts.

import { base64ToBytes, decodeQuotedPrintable } from './decode.js';

/** A stateful decoder: feed raw (transfer-encoded) chunks, get decoded bytes out; flush() at EOF. */
export interface StreamingDecoder {
  /** Decode as much of `chunk` as is unambiguous; hold the rest until the next push/flush. */
  push(chunk: Uint8Array): Uint8Array;
  /** Decode any held remainder at end-of-part. */
  flush(): Uint8Array;
}

const EMPTY = new Uint8Array(0);

/** latin1 string → bytes (exact 1:1, the inverse of decode.ts `bytesToLatin1`). */
function latin1ToBytes(s: string): Uint8Array {
  const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i) & 0xff;
  return out;
}

/** base64: accumulate alphabet chars, decode in multiples of 4, carry a <4-char remainder. */
function base64Decoder(): StreamingDecoder {
  let acc = ''; // pending base64-alphabet chars (< 4 after each push)
  return {
    push(chunk) {
      for (let i = 0; i < chunk.length; i++) {
        const c = chunk[i]!;
        // A–Z a–z 0–9 + / — strip everything else (whitespace, CRLF between body lines)
        if (
          (c >= 65 && c <= 90) ||
          (c >= 97 && c <= 122) ||
          (c >= 48 && c <= 57) ||
          c === 43 ||
          c === 47
        ) {
          acc += String.fromCharCode(c);
        }
      }
      const usable = acc.length - (acc.length % 4);
      if (usable === 0) return EMPTY;
      const take = acc.slice(0, usable);
      acc = acc.slice(usable);
      return base64ToBytes(take); // already a multiple of 4 — no padding added
    },
    flush() {
      if (acc.length < 2) {
        acc = '';
        return EMPTY; // a lone trailing char carries no bytes (matches the buffered decoder)
      }
      const out = base64ToBytes(acc); // base64ToBytes re-pads 2/3 chars → 1/2 bytes
      acc = '';
      return out;
    },
  };
}

/** quoted-printable: hold a trailing partial escape/soft-break (up to 2 chars starting with `=`). */
function qpDecoder(): StreamingDecoder {
  let leftover = '';
  return {
    push(chunk) {
      let s = leftover;
      for (let i = 0; i < chunk.length; i++) s += String.fromCharCode(chunk[i]!);
      // Don't split `=` (could be `=XX` or a `=\r\n` soft break) or `=X` across the boundary.
      let end = s.length;
      if (s.length >= 1 && s[s.length - 1] === '=') end = s.length - 1;
      else if (s.length >= 2 && s[s.length - 2] === '=') end = s.length - 2;
      leftover = s.slice(end);
      if (end === 0) return EMPTY;
      return decodeQuotedPrintable(latin1ToBytes(s.slice(0, end)));
    },
    flush() {
      if (!leftover) return EMPTY;
      const out = decodeQuotedPrintable(latin1ToBytes(leftover)); // tolerant of a truncated escape at EOF
      leftover = '';
      return out;
    },
  };
}

/** identity (7bit/8bit/binary/unknown): pass bytes through untouched. */
function identityDecoder(): StreamingDecoder {
  return { push: (chunk) => chunk, flush: () => EMPTY };
}

/** Build a streaming decoder for a Content-Transfer-Encoding. Mirrors `decodeTransfer`'s dispatch. */
export function createTransferDecoder(encoding: string): StreamingDecoder {
  switch (encoding.toLowerCase().trim()) {
    case 'base64':
      return base64Decoder();
    case 'quoted-printable':
      return qpDecoder();
    default:
      return identityDecoder();
  }
}
