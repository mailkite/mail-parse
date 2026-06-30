// Docs: docs/architecture/mime-parser-implementation.md
//
// Transfer-encoding + charset decoding. Charset uses the runtime's full-ICU TextDecoder
// (Node ≥ full-icu, modern browsers/Workers), which covers utf-8, shift_jis, iso-8859-*,
// windows-125x, etc. — so we avoid an iconv dependency. Unknown labels fall back to utf-8
// with a diagnostic (mime-parser.md §4, tolerance is collected, never thrown).

/** Decode a base64 body. Tolerant: strips whitespace and stray non-alphabet bytes. */
export function decodeBase64(raw: Uint8Array): Uint8Array {
  return base64ToBytes(bytesToLatin1(raw));
}

/** Portable base64 → bytes (atob, no Buffer). Tolerant of missing padding + stray characters. */
export function base64ToBytes(s: string): Uint8Array {
  let clean = s.replace(/[^A-Za-z0-9+/]/g, '');
  while (clean.length % 4) clean += '=';
  let bin: string;
  try {
    bin = atob(clean);
  } catch {
    return new Uint8Array(0);
  }
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

/** Decode a quoted-printable body (RFC 2045 §6.7): `=XX` hex escapes + `=` soft line breaks. */
export function decodeQuotedPrintable(raw: Uint8Array): Uint8Array {
  const s = bytesToLatin1(raw);
  const out: number[] = [];
  for (let i = 0; i < s.length; i++) {
    const ch = s[i]!;
    if (ch === '=') {
      const next = s.slice(i + 1, i + 3);
      if (next === '\r\n' || next[0] === '\n') {
        // soft line break — consume the newline
        i += next[0] === '\r' ? 2 : 1;
        continue;
      }
      const hex = s.slice(i + 1, i + 3);
      if (/^[0-9A-Fa-f]{2}$/.test(hex)) {
        out.push(parseInt(hex, 16));
        i += 2;
        continue;
      }
      // malformed `=` — pass through literally
      out.push(0x3d);
    } else {
      out.push(ch.charCodeAt(0) & 0xff);
    }
  }
  return Uint8Array.from(out);
}

/**
 * Apply a Content-Transfer-Encoding. Unknown encodings pass through as-is (7bit/8bit/binary).
 */
export function decodeTransfer(raw: Uint8Array, encoding: string): Uint8Array {
  switch (encoding.toLowerCase().trim()) {
    case 'base64':
      return decodeBase64(raw);
    case 'quoted-printable':
      return decodeQuotedPrintable(raw);
    default:
      return raw;
  }
}

/**
 * Decode bytes to a string using a charset label. Returns `ok: false` (and a utf-8 best-effort
 * string) when the label is unsupported by the runtime, so the caller can record a diagnostic.
 */
export function decodeCharset(
  bytes: Uint8Array,
  charset: string | undefined,
): { text: string; ok: boolean; label: string } {
  const label = (charset || 'utf-8').toLowerCase().trim();
  try {
    return { text: new TextDecoder(label, { fatal: false }).decode(bytes), ok: true, label };
  } catch {
    // Unknown label — best-effort utf-8 and flag it.
    return { text: new TextDecoder('utf-8', { fatal: false }).decode(bytes), ok: false, label };
  }
}

/** Interpret raw bytes as latin1 (exact 1:1 byte→codepoint, ISO-8859-1) — header/structure scanning.
 * Portable (no Buffer); note TextDecoder('latin1') is actually windows-1252, so we map by hand.
 * Chunked to stay under the argument-count limit of String.fromCharCode. */
export function bytesToLatin1(bytes: Uint8Array): string {
  let out = '';
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    out += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return out;
}
