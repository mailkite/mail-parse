// Docs: docs/architecture/mime-parser-implementation.md
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { parse } from '../src/parse.js';
import { decodeBase64, base64ToBytes, bytesToLatin1 } from '../src/decode.js';

const DIR = fileURLToPath(new URL('./fixtures/eml', import.meta.url));

function streamOf(bytes: Uint8Array, chunk = 64): ReadableStream<Uint8Array> {
  let i = 0;
  return new ReadableStream<Uint8Array>({
    pull(controller) {
      if (i >= bytes.length) {
        controller.close();
        return;
      }
      controller.enqueue(bytes.subarray(i, Math.min(i + chunk, bytes.length)));
      i += chunk;
    },
  });
}

describe('Web Streams input', () => {
  it('parse() accepts a ReadableStream and matches the buffered result', async () => {
    const raw = new Uint8Array(readFileSync(`${DIR}/mime_nested_attachment.eml`));
    const buffered = await parse(raw);
    const streamed = await parse(streamOf(raw, 48));
    expect(streamed.subject).toBe(buffered.subject);
    expect(streamed.text).toBe(buffered.text);
    expect(streamed.attachments.length).toBe(buffered.attachments.length);
    expect(streamed.attachments[0]?.size).toBe(buffered.attachments[0]?.size);
  });

  it('parse() works through a TransformStream pipe', async () => {
    const raw = new Uint8Array(readFileSync(`${DIR}/plain_basic.eml`));
    const identity = new TransformStream<Uint8Array, Uint8Array>();
    streamOf(raw, 32).pipeTo(identity.writable);
    const p = await parse(identity.readable);
    expect(p.from?.address).toBe('test@lindsaar.net');
    expect(p.text).toContain('Plain email.');
  });
});

describe('portable codecs (no Buffer)', () => {
  it('base64ToBytes decodes (padded + unpadded)', () => {
    expect(bytesToLatin1(base64ToBytes('aGVsbG8='))).toBe('hello');
    expect(bytesToLatin1(base64ToBytes('aGVsbG8'))).toBe('hello'); // missing padding tolerated
  });
  it('decodeBase64 round-trips bytes including 0x00..0xFF', () => {
    const all = new Uint8Array(256);
    for (let i = 0; i < 256; i++) all[i] = i;
    const b64 = btoa(bytesToLatin1(all));
    const back = decodeBase64(new TextEncoder().encode(b64));
    expect(back.length).toBe(256);
    expect(back[0]).toBe(0);
    expect(back[255]).toBe(255);
  });
  it('bytesToLatin1 is exact 1:1 (not windows-1252)', () => {
    // 0x80–0x9F are C1 controls in true latin1; windows-1252 would remap them.
    expect(bytesToLatin1(Uint8Array.of(0x80, 0x92, 0x9f)).charCodeAt(1)).toBe(0x92);
  });
});
