// Docs: docs/architecture/mime-parser-implementation.md
//
// Phase 1 follow-up: streaming attachment decode. Proves the streaming path (parseStream + the incremental
// transfer-decoders) yields byte-for-byte the same bytes as the buffered parse(), handles chunk boundaries
// that split base64 quads / QP escapes, and is genuinely incremental (never buffers the whole part).

import { describe, it, expect } from 'vitest';
import { parse } from '../src/parse.js';
import { parseStream } from '../src/stream.js';
import { createTransferDecoder } from '../src/stream-decode.js';
import type { PartMeta } from '../src/types.js';

/** Feed `bytes` to parseStream in fixed-size chunks (to exercise cross-chunk carry). */
async function streamAttachments(
  raw: Uint8Array,
  chunkSize: number,
): Promise<{ meta: PartMeta; body: Uint8Array; chunkCount: number; maxChunk: number }[]> {
  async function* chunks(): AsyncGenerator<Uint8Array> {
    for (let i = 0; i < raw.length; i += chunkSize) yield raw.subarray(i, i + chunkSize);
  }
  const collectors = new Map<PartMeta, { parts: Uint8Array[]; chunkCount: number; maxChunk: number }>();
  const done: { meta: PartMeta; body: Uint8Array; chunkCount: number; maxChunk: number }[] = [];
  await parseStream(chunks(), {
    onNodeStart(meta) {
      if (!meta.isMultipart) collectors.set(meta, { parts: [], chunkCount: 0, maxChunk: 0 });
    },
    onBodyChunk(meta, decoded) {
      const c = collectors.get(meta);
      if (c) {
        c.parts.push(decoded);
        c.chunkCount++;
        c.maxChunk = Math.max(c.maxChunk, decoded.length);
      }
    },
    onNodeEnd(meta) {
      const c = collectors.get(meta);
      if (!c) return;
      collectors.delete(meta);
      const total = c.parts.reduce((n, p) => n + p.length, 0);
      const body = new Uint8Array(total);
      let off = 0;
      for (const p of c.parts) {
        body.set(p, off);
        off += p.length;
      }
      done.push({ meta, body, chunkCount: c.chunkCount, maxChunk: c.maxChunk });
    },
  });
  return done;
}

const enc = (s: string) => new TextEncoder().encode(s);

describe('streaming transfer-decode primitive', () => {
  it('base64 decodes identically regardless of chunk split (quad boundaries)', () => {
    const src = 'SGVsbG8sIHdvcmxkISBUaGlzIGlzIGEgYmFzZTY0IHN0cmluZy4='; // "Hello, world! This is a base64 string."
    const whole = createTransferDecoder('base64');
    const wholeOut = concat([whole.push(enc(src)), whole.flush()]);
    for (const size of [1, 3, 4, 5, 7, 100]) {
      const d = createTransferDecoder('base64');
      const parts: Uint8Array[] = [];
      for (let i = 0; i < src.length; i += size) parts.push(d.push(enc(src.slice(i, i + size))));
      parts.push(d.flush());
      expect(new TextDecoder().decode(concat(parts))).toBe('Hello, world! This is a base64 string.');
      expect(concat(parts)).toEqual(wholeOut);
    }
  });

  it('quoted-printable decodes identically when an =XX escape or soft break is split', () => {
    // "café" (é = =C3=A9) + a soft line break in the middle of a word.
    const src = 'caf=C3=A9 and a soft=\r\nbreak here=3D end';
    const expected = 'café and a softbreak here= end';
    for (const size of [1, 2, 3, 6]) {
      const d = createTransferDecoder('quoted-printable');
      const parts: Uint8Array[] = [];
      for (let i = 0; i < src.length; i += size) parts.push(d.push(enc(src.slice(i, i + size))));
      parts.push(d.flush());
      expect(new TextDecoder().decode(concat(parts))).toBe(expected);
    }
  });
});

describe('parseStream — parity with buffered parse() + genuinely incremental', () => {
  it('streams a ~1.5MB base64 attachment; bytes match parse() exactly and arrive in many chunks', async () => {
    const size = 1_500_000;
    const bytes = new Uint8Array(size);
    for (let i = 0; i < size; i++) bytes[i] = i & 0xff;
    // Wrap at 76 columns like a real MIME encoder (RFC 2045) — so the body is many lines, not one.
    const b64 = Buffer.from(bytes).toString('base64').replace(/(.{76})/g, '$1\r\n');
    const raw =
      'Content-Type: multipart/mixed; boundary=b\r\n\r\n' +
      '--b\r\nContent-Type: text/plain\r\n\r\nhi\r\n' +
      '--b\r\nContent-Type: application/octet-stream\r\n' +
      'Content-Transfer-Encoding: base64\r\n' +
      'Content-Disposition: attachment; filename="big.bin"\r\n\r\n' +
      b64 +
      '\r\n--b--\r\n';

    // Buffered baseline.
    const buffered = await parse(raw);
    expect(buffered.attachments.length).toBe(1);
    const expected = buffered.attachments[0]!.content;

    // Streamed, fed in 64KB chunks.
    const streamed = await streamAttachments(enc(raw), 64 * 1024);
    const attach = streamed.find((s) => s.meta.filename === 'big.bin')!;
    expect(attach).toBeTruthy();
    expect(attach.body.length).toBe(size);
    expect(attach.body).toEqual(expected); // byte-for-byte parity
    // Incremental: delivered in many chunks, none anywhere near the whole part.
    expect(attach.chunkCount).toBeGreaterThan(10);
    expect(attach.maxChunk).toBeLessThan(size / 2);
  });

  it('surfaces diagnostics and handles quoted-printable + text leaves', async () => {
    const raw =
      'Content-Type: text/plain; charset=utf-8\r\n' +
      'Content-Transfer-Encoding: quoted-printable\r\n\r\n' +
      'Re=\r\nsum=C3=A9\r\n';
    const out = await streamAttachments(enc(raw), 3);
    expect(out.length).toBe(1);
    expect(new TextDecoder().decode(out[0]!.body)).toContain('Resumé');
  });
});

function concat(arrs: Uint8Array[]): Uint8Array {
  const total = arrs.reduce((n, a) => n + a.length, 0);
  const out = new Uint8Array(total);
  let off = 0;
  for (const a of arrs) {
    out.set(a, off);
    off += a.length;
  }
  return out;
}
