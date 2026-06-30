// Docs: docs/architecture/mime-parser-implementation.md
//
// Header parsing: unfolding (RFC 5322 §2.2.3), structured-field parameters (RFC 2045 +
// RFC 2231 extended/`filename*`), RFC 2047 encoded-words, and a common-case address parser.

import { decodeCharset } from './decode.js';
import type { Address, Header } from './types.js';

/** Parse a raw header block (already split from the body) into ordered, unfolded headers. */
export function parseHeaderBlock(block: string): Header[] {
  const headers: Header[] = [];
  // Unfold: a line starting with WSP is a continuation of the previous header.
  const lines = block.split(/\r?\n/);
  let current: { key: string; value: string } | null = null;
  for (const line of lines) {
    if (line === '') continue;
    if (/^[ \t]/.test(line) && current) {
      current.value += ' ' + line.trim();
      continue;
    }
    const idx = line.indexOf(':');
    if (idx === -1) continue; // not a header line; skip (tolerant)
    if (current) headers.push(current);
    current = { key: line.slice(0, idx).trim(), value: line.slice(idx + 1).trim() };
  }
  if (current) headers.push(current);
  return headers;
}

/** Case-insensitive header lookup (first match). */
export function getHeader(headers: Header[], name: string): string | undefined {
  const lower = name.toLowerCase();
  return headers.find((h) => h.key.toLowerCase() === lower)?.value;
}

export interface StructuredField {
  /** The primary value before the first `;` (lowercased, trimmed). e.g. "multipart/mixed". */
  value: string;
  /** Parameters, lowercased keys. RFC 2231 `name*` continuations + charset are folded in. */
  params: Record<string, string>;
}

/**
 * Parse a structured field like `multipart/mixed; boundary="x"; name*=UTF-8''%E2%82%AC`.
 * Handles quoted values and RFC 2231 extended-value (`key*=charset'lang'pct-encoded`) +
 * continuations (`key*0`, `key*1`).
 */
export function parseStructuredField(raw: string): StructuredField {
  const parts = splitSemicolons(raw);
  const value = (parts.shift() ?? '').trim().toLowerCase();
  // RFC 2231: collect each parameter's continuation segments keyed by base name → index, so we
  // can reassemble them in INDEX order (not header-appearance order) and let a duplicate of a
  // simple param overwrite rather than concatenate.
  const segs = new Map<string, Map<number, string>>();
  const ext = new Set<string>();
  for (const p of parts) {
    const eq = p.indexOf('=');
    if (eq === -1) continue;
    let key = p.slice(0, eq).trim().toLowerCase();
    let val = p.slice(eq + 1).trim();
    if (val.startsWith('"') && val.endsWith('"')) val = val.slice(1, -1);
    // Key forms: `name`, `name*` (extended/pct-encoded), `name*N` (continuation),
    // `name*N*` (continuation + extended). Strip the trailing `*` first, then the `*N` index.
    if (key.endsWith('*')) {
      key = key.slice(0, -1);
      ext.add(stripIndex(key));
    }
    let index = 0;
    const cont = key.match(/^(.*)\*(\d+)$/);
    if (cont) {
      key = cont[1]!;
      index = Number(cont[2]);
    }
    let m = segs.get(key);
    if (!m) {
      m = new Map();
      segs.set(key, m);
    }
    m.set(index, val); // last-wins for a repeated index (deduplicates accidental duplicates)
  }
  const params: Record<string, string> = {};
  for (const [k, m] of segs) {
    const joined = [...m.keys()]
      .sort((a, b) => a - b)
      .map((i) => m.get(i)!)
      .join('');
    params[k] = ext.has(k) ? decodeRfc2231(joined) : joined;
  }
  return { value, params };
}

/** `name*0` → `name` (used to record the extended flag against the base name). */
function stripIndex(key: string): string {
  return key.match(/^(.*)\*\d+$/)?.[1] ?? key;
}

/** RFC 2231 extended value: `charset'lang'pct-encoded`. */
function decodeRfc2231(v: string): string {
  const m = v.match(/^([^']*)'([^']*)'(.*)$/);
  if (!m) return decodeURISafe(v);
  const charset = m[1] || 'utf-8';
  const bytes = pctDecodeToBytes(m[3] ?? '');
  return decodeCharset(bytes, charset).text;
}

function pctDecodeToBytes(s: string): Uint8Array {
  const out: number[] = [];
  for (let i = 0; i < s.length; i++) {
    if (s[i] === '%' && /^[0-9A-Fa-f]{2}$/.test(s.slice(i + 1, i + 3))) {
      out.push(parseInt(s.slice(i + 1, i + 3), 16));
      i += 2;
    } else {
      out.push(s.charCodeAt(i) & 0xff);
    }
  }
  return Uint8Array.from(out);
}

function decodeURISafe(s: string): string {
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
}

/** Split on `;` but not inside quoted strings. */
function splitSemicolons(s: string): string[] {
  const out: string[] = [];
  let buf = '';
  let inQuote = false;
  for (let i = 0; i < s.length; i++) {
    const ch = s[i]!;
    if (ch === '"') inQuote = !inQuote;
    if (ch === ';' && !inQuote) {
      out.push(buf);
      buf = '';
    } else {
      buf += ch;
    }
  }
  out.push(buf);
  return out;
}

/**
 * Decode RFC 2047 encoded-words: `=?charset?B?...?=` / `=?charset?Q?...?=`. Adjacent encoded
 * words are concatenated; whitespace strictly between two encoded words is dropped (RFC 2047 §6.2).
 */
export function decodeEncodedWords(input: string): string {
  if (!input.includes('=?')) return input;
  const token = /=\?([^?]+)\?([BbQq])\?([^?]*)\?=/g;
  let out = '';
  let lastEnd = 0;
  let prevWasWord = false;
  let m: RegExpExecArray | null;
  while ((m = token.exec(input))) {
    const between = input.slice(lastEnd, m.index);
    if (!(prevWasWord && between.trim() === '')) out += between;
    const charset = m[1]!.split('*')[0]!; // strip an RFC 2231 `*language` suffix on the charset token
    const enc = m[2]!.toUpperCase();
    const data = m[3]!;
    const bytes = enc === 'B' ? Uint8Array.from(Buffer.from(data, 'base64')) : decodeQWord(data);
    out += decodeCharset(bytes, charset).text;
    lastEnd = m.index + m[0].length;
    prevWasWord = true;
  }
  out += input.slice(lastEnd);
  return out;
}

/** RFC 2047 "Q" encoding: like quoted-printable but `_` means space. */
function decodeQWord(s: string): Uint8Array {
  const out: number[] = [];
  for (let i = 0; i < s.length; i++) {
    const ch = s[i]!;
    if (ch === '_') {
      out.push(0x20);
    } else if (ch === '=' && /^[0-9A-Fa-f]{2}$/.test(s.slice(i + 1, i + 3))) {
      out.push(parseInt(s.slice(i + 1, i + 3), 16));
      i += 2;
    } else {
      out.push(ch.charCodeAt(0) & 0xff);
    }
  }
  return Uint8Array.from(out);
}

/**
 * Parse an address-list header (From/To/Cc/…). Common-case subset: `Name <addr>`, bare `addr`,
 * comma-separated lists, quoted display names. Groups + comments are a Phase 1 follow-up.
 */
export function parseAddressList(raw: string | undefined): Address[] {
  if (!raw) return [];
  const out: Address[] = [];
  for (const chunk of splitAddressCommas(raw)) {
    const s = chunk.trim();
    if (!s) continue;
    const angle = s.match(/^(.*)<([^>]*)>\s*$/);
    if (angle) {
      const name = decodeEncodedWords(unquote(angle[1]!.trim())).trim();
      out.push({ address: angle[2]!.trim(), ...(name ? { name } : {}) });
    } else {
      out.push({ address: s });
    }
  }
  return out;
}

/** First address of a list, or undefined. */
export function parseSingleAddress(raw: string | undefined): Address | undefined {
  return parseAddressList(raw)[0];
}

function splitAddressCommas(s: string): string[] {
  const out: string[] = [];
  let buf = '';
  let inQuote = false;
  let inAngle = false;
  for (let i = 0; i < s.length; i++) {
    const ch = s[i]!;
    if (ch === '"') inQuote = !inQuote;
    else if (!inQuote && ch === '<') inAngle = true;
    else if (!inQuote && ch === '>') inAngle = false;
    if (ch === ',' && !inQuote && !inAngle) {
      out.push(buf);
      buf = '';
    } else {
      buf += ch;
    }
  }
  out.push(buf);
  return out;
}

function unquote(s: string): string {
  if (s.startsWith('"') && s.endsWith('"')) return s.slice(1, -1).replace(/\\(.)/g, '$1');
  return s;
}
