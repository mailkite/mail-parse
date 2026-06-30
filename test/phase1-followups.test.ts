// Docs: docs/architecture/mime-parser-implementation.md
import { describe, it, expect } from 'vitest';
import { parse } from '../src/parse.js';
import { unflowFormat } from '../src/flowed.js';
import { parseAddressList } from '../src/headers.js';

describe('format=flowed (RFC 3676)', () => {
  it('joins soft-wrapped lines (trailing space) and keeps hard breaks', () => {
    const flowed = 'This is a long \nparagraph that wraps.\nHard break here.';
    expect(unflowFormat(flowed)).toBe('This is a long paragraph that wraps.\nHard break here.');
  });

  it('delsp=yes removes the soft-break space', () => {
    expect(unflowFormat('to \nbe', true)).toBe('tobe');
    expect(unflowFormat('to \nbe', false)).toBe('to be');
  });

  it('parse() reflows a text/plain; format=flowed body', async () => {
    const raw =
      'Content-Type: text/plain; format=flowed\r\n\r\n' +
      'This is a long \r\nparagraph that wraps.\r\nDone.\r\n';
    const p = await parse(raw);
    expect(p.text).toContain('This is a long paragraph that wraps.');
    expect(p.text).toContain('Done.');
  });
});

describe('RFC 5322 address edge cases', () => {
  it('parses a group syntax, dropping the label', () => {
    const list = parseAddressList('Friends: alice@example.com, bob@example.com;');
    expect(list.map((a) => a.address)).toEqual(['alice@example.com', 'bob@example.com']);
  });

  it('strips comments', () => {
    const list = parseAddressList('alice@example.com (Alice), bob@example.com (Bob H.)');
    expect(list.map((a) => a.address)).toEqual(['alice@example.com', 'bob@example.com']);
  });

  it('still handles plain Name <addr> lists', () => {
    const list = parseAddressList('Ada Lovelace <ada@x.com>, grace@y.com');
    expect(list[0]).toEqual({ address: 'ada@x.com', name: 'Ada Lovelace' });
    expect(list[1]!.address).toBe('grace@y.com');
  });
});

describe('large-message profile (streaming holds up)', () => {
  it('parses a ~1.5MB base64 attachment and recovers the bytes', async () => {
    const size = 1_500_000;
    const bytes = new Uint8Array(size);
    for (let i = 0; i < size; i++) bytes[i] = i & 0xff;
    const b64 = Buffer.from(bytes).toString('base64');
    const raw =
      'Content-Type: multipart/mixed; boundary=b\r\n\r\n' +
      '--b\r\nContent-Type: text/plain\r\n\r\nhi\r\n' +
      '--b\r\nContent-Type: application/octet-stream\r\n' +
      'Content-Transfer-Encoding: base64\r\n' +
      'Content-Disposition: attachment; filename="big.bin"\r\n\r\n' +
      b64 +
      '\r\n--b--\r\n';
    const p = await parse(raw);
    expect(p.attachments.length).toBe(1);
    expect(p.attachments[0]!.size).toBe(size);
    expect(p.attachments[0]!.content[0]).toBe(0);
    expect(p.attachments[0]!.content[255]).toBe(255);
  });
});
