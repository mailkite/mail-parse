// Docs: docs/architecture/mime-parser-implementation.md
// Regressions for defects found in the Phase 1 code-health review.
import { describe, it, expect } from 'vitest';
import { parse } from '../src/parse.js';
import {
  parseStructuredField,
  parseAddressList,
  decodeEncodedWords,
} from '../src/headers.js';

describe('RFC 2231 parameter continuations', () => {
  it('reassembles out-of-order continuation segments by index', () => {
    const f = parseStructuredField('attachment; filename*1="b"; filename*0="a"');
    expect(f.params['filename']).toBe('ab');
  });

  it('a duplicate simple parameter does not concatenate (last wins)', () => {
    const f = parseStructuredField('text/plain; charset=utf-8; charset=us-ascii');
    expect(f.params['charset']).toBe('us-ascii');
  });

  it('decodes an extended (pct-encoded) filename* value', () => {
    const f = parseStructuredField("attachment; filename*=UTF-8''Caf%C3%A9.txt");
    expect(f.params['filename']).toBe('Café.txt');
  });
});

describe('RFC 2047 encoded-words', () => {
  it('strips a *language suffix on the charset token', () => {
    // ISO-8859-1, byte 0xE9 = é; without the strip this falls back to utf-8 -> U+FFFD.
    expect(decodeEncodedWords('=?ISO-8859-1*en?Q?Caf=E9?=')).toBe('Café');
  });
});

describe('address list splitting', () => {
  it('does not let a < inside a quoted local-part swallow the separator comma', () => {
    const list = parseAddressList('"a<b"@host.com, c@d.com');
    expect(list.length).toBe(2);
    expect(list[1]!.address).toBe('c@d.com');
  });
});

describe('headers running to EOF without a terminating blank line', () => {
  it('still emits a parsed message (header-only, no body, no final CRLFCRLF)', async () => {
    const p = await parse('Subject: Hi\r\nFrom: a@b.com\r\n');
    expect(p.subject).toBe('Hi');
    expect(p.from?.address).toBe('a@b.com');
  });
});

describe('buffer-reusing source does not corrupt body', () => {
  it('reuses one backing buffer across chunks; output stays correct', async () => {
    const enc = new TextEncoder();
    const c1 = enc.encode('Subject: t\r\n\r\nline1\r\nline2\r\n');
    const c2 = enc.encode('line3 is longer than the rest aaaaaaaa\r\n');
    const backing = new Uint8Array(Math.max(c1.length, c2.length));
    async function* reusing(): AsyncGenerator<Uint8Array> {
      backing.set(c1);
      yield backing.subarray(0, c1.length);
      backing.fill(0);
      backing.set(c2);
      yield backing.subarray(0, c2.length);
    }
    const p = await parse(reusing());
    // Before the .slice() fix, line2 (parked in `pending` across the pull) was overwritten
    // by line3's bytes from the reused buffer.
    expect(p.text).toContain('line1');
    expect(p.text).toContain('line2');
    expect(p.text).toContain('line3 is longer than the rest');
  });
});
