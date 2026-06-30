// Docs: docs/architecture/mime-parser-implementation.md
//
// Deterministic repro generation (mime-parser.md §8.0) — NOT an AI rebuild. Two transforms:
//   1. minimizeFailure: ddmin (delta-debugging) to the smallest line-set that still triggers the
//      failure, given an oracle. Removes ~all PII as a side effect.
//   2. skeletonize: structure-preserving anonymization — keep header NAMES, structural headers,
//      boundaries, encodings, and all non-ASCII bytes (the stuff that breaks parsing); replace only
//      readable ASCII letters/digits in non-structural lines with deterministic filler.

const STRUCTURAL_HEADERS = new Set([
  'content-type',
  'content-transfer-encoding',
  'content-disposition',
  'content-id',
  'mime-version',
]);

export interface ScrubbedSample {
  bytes: Uint8Array;
  /** True if a verbatim region (the failing bytes) was preserved and may still hold PII. */
  containsVerbatim: boolean;
}

/**
 * Structure-preserving scrub. Header values are replaced with filler EXCEPT structural headers;
 * body tokens (ASCII letters→'x', digits→'0') are filled; non-ASCII bytes, punctuation, whitespace,
 * and boundary lines (`--...`) are kept verbatim so the failure still reproduces.
 */
export function skeletonize(raw: Uint8Array): ScrubbedSample {
  const lines = splitKeepEol(raw);
  let inHeaders = true;
  const out: Uint8Array[] = [];
  for (const line of lines) {
    const text = latin1(line.content);
    if (inHeaders && text === '') {
      inHeaders = false;
      out.push(line.full);
      continue;
    }
    if (text.startsWith('--')) {
      out.push(line.full); // boundary — keep verbatim
      continue;
    }
    if (inHeaders && /^[ \t]/.test(text)) {
      out.push(rebuild(scrubBody(line.content), line.eol)); // header continuation
      continue;
    }
    if (inHeaders) {
      const colon = text.indexOf(':');
      if (colon !== -1) {
        const name = text.slice(0, colon).trim().toLowerCase();
        if (STRUCTURAL_HEADERS.has(name)) {
          out.push(line.full); // keep structural headers verbatim (content-type, boundary, encoding…)
          continue;
        }
        const keyBytes = line.content.subarray(0, colon + 1);
        const valBytes = scrubBody(line.content.subarray(colon + 1));
        out.push(rebuild(concat(keyBytes, valBytes), line.eol));
        continue;
      }
    }
    out.push(rebuild(scrubBody(line.content), line.eol));
  }
  return { bytes: concatAll(out), containsVerbatim: false };
}

/** ASCII letters → 'x', digits → '0'; everything else (incl. non-ASCII bytes) kept verbatim. */
function scrubBody(bytes: Uint8Array): Uint8Array {
  const out = new Uint8Array(bytes.length);
  for (let i = 0; i < bytes.length; i++) {
    const b = bytes[i]!;
    if (b >= 0x41 && b <= 0x5a) out[i] = 0x78; // A-Z → x
    else if (b >= 0x61 && b <= 0x7a) out[i] = 0x78; // a-z → x
    else if (b >= 0x30 && b <= 0x39) out[i] = 0x30; // 0-9 → 0
    else out[i] = b;
  }
  return out;
}

/** An oracle: given candidate bytes, does the failure still reproduce? */
export type FailureOracle = (candidate: Uint8Array) => boolean | Promise<boolean>;

/**
 * Delta-debugging minimization to the smallest set of lines that still satisfies `oracle`.
 * Classic ddmin over physical lines. Assumes `oracle(raw)` is already true.
 */
export async function minimizeFailure(raw: Uint8Array, oracle: FailureOracle): Promise<Uint8Array> {
  const lines = splitKeepEol(raw).map((l) => l.full);
  let current = lines.map((_, i) => i); // indices still included
  let granularity = 2;

  const candidateOf = (indices: number[]): Uint8Array => concatAll(indices.map((i) => lines[i]!));

  while (current.length >= 2) {
    const chunkSize = Math.ceil(current.length / granularity);
    let reduced = false;
    for (let start = 0; start < current.length; start += chunkSize) {
      // Try the complement (current minus this chunk).
      const complement = current.slice(0, start).concat(current.slice(start + chunkSize));
      if (complement.length && (await oracle(candidateOf(complement)))) {
        current = complement;
        granularity = Math.max(granularity - 1, 2);
        reduced = true;
        break;
      }
    }
    if (!reduced) {
      if (granularity >= current.length) break;
      granularity = Math.min(current.length, granularity * 2);
    }
  }
  return candidateOf(current);
}

// --- line utilities -------------------------------------------------------------------------------

interface Ln {
  content: Uint8Array; // without EOL
  eol: Uint8Array; // "" | "\n" | "\r\n"
  full: Uint8Array; // content + eol
}

function splitKeepEol(raw: Uint8Array): Ln[] {
  const out: Ln[] = [];
  let start = 0;
  for (let i = 0; i < raw.length; i++) {
    if (raw[i] === 0x0a) {
      const hasCR = i > start && raw[i - 1] === 0x0d;
      const content = raw.subarray(start, hasCR ? i - 1 : i);
      const eol = raw.subarray(hasCR ? i - 1 : i, i + 1);
      out.push({ content, eol, full: raw.subarray(start, i + 1) });
      start = i + 1;
    }
  }
  if (start < raw.length) {
    const content = raw.subarray(start);
    out.push({ content, eol: new Uint8Array(0), full: content });
  }
  return out;
}

function rebuild(content: Uint8Array, eol: Uint8Array): Uint8Array {
  return concat(content, eol);
}

function latin1(bytes: Uint8Array): string {
  // Exact 1:1 byte→codepoint, portable (no Buffer); chunked for the fromCharCode arg limit.
  let out = '';
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) out += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  return out;
}

function concat(a: Uint8Array, b: Uint8Array): Uint8Array {
  const out = new Uint8Array(a.length + b.length);
  out.set(a, 0);
  out.set(b, a.length);
  return out;
}

function concatAll(parts: Uint8Array[]): Uint8Array {
  let total = 0;
  for (const p of parts) total += p.length;
  const out = new Uint8Array(total);
  let off = 0;
  for (const p of parts) {
    out.set(p, off);
    off += p.length;
  }
  return out;
}
