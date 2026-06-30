// Docs: docs/architecture/mime-parser-implementation.md
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { parse } from '../src/parse.js';
import { Registry, Part, type Middleware } from '../src/middleware.js';
import { matches, specificity } from '../src/match.js';
import { ArrayTrace } from '../src/trace.js';
import { charsetRepair, languageDetect, winmailDetect } from '../src/middlewares/index.js';
import type { PartMeta } from '../src/types.js';

const DIR = fileURLToPath(new URL('./fixtures/eml', import.meta.url));

function meta(over: Partial<PartMeta> = {}): PartMeta {
  return {
    depth: 1,
    headers: [],
    contentType: 'text/plain',
    mainType: 'text',
    encoding: '7bit',
    isMultipart: false,
    path: 'text/plain',
    ...over,
  };
}

describe('match engine', () => {
  it('matches by exact content-type and main type', () => {
    const m = meta({ contentType: 'application/pdf', mainType: 'application' });
    expect(matches({ contentType: 'application/pdf' }, m, new Uint8Array())).toBe(true);
    expect(matches({ contentType: 'text/plain' }, m, new Uint8Array())).toBe(false);
    expect(matches({ maintype: 'application' }, m, new Uint8Array())).toBe(true);
  });

  it('matches a byte signature against the body', () => {
    const body = Uint8Array.of(0x78, 0x9f, 0x3e, 0x22, 0x00);
    expect(matches({ byteSignature: { offset: 0, hexPrefix: '789f3e22' } }, meta(), body)).toBe(true);
    expect(matches({ byteSignature: { offset: 0, hexPrefix: 'deadbeef' } }, meta(), body)).toBe(false);
  });

  it('an exact content-type scores more specific than a bare main type', () => {
    expect(specificity({ contentType: 'application/pdf' })).toBeGreaterThan(specificity({ maintype: 'text' }));
  });
});

describe('registry chain', () => {
  function recorder(name: string, log: string[], callNext = true): Middleware {
    return {
      name,
      phase: 'enrich',
      match: { maintype: 'text' },
      async onPart(_part, next) {
        log.push(name);
        if (callNext) await next();
      },
    };
  }

  it('runs matched middleware in order (onion)', async () => {
    const log: string[] = [];
    const r = new Registry().use(recorder('a', log)).use(recorder('b', log));
    await r.runPart(new Part(meta(), new Uint8Array()));
    expect(log).toEqual(['a', 'b']);
  });

  it('a middleware that does not call next() short-circuits the rest', async () => {
    const log: string[] = [];
    const r = new Registry().use(recorder('a', log, false)).use(recorder('b', log));
    await r.runPart(new Part(meta(), new Uint8Array()));
    expect(log).toEqual(['a']);
  });

  it('a throwing middleware is contained: diagnostic recorded + chain recovers', async () => {
    const log: string[] = [];
    const boom: Middleware = {
      name: 'boom',
      phase: 'decode',
      match: { maintype: 'text' },
      onPart() {
        throw new Error('kaboom');
      },
    };
    const part = new Part(meta(), new Uint8Array());
    const r = new Registry().use(boom).use(recorder('after', log));
    await r.runPart(part);
    expect(log).toEqual(['after']); // recovered past the failure
    expect(part.diagnostics.some((d) => d.code === 'MIDDLEWARE_ERROR')).toBe(true);
  });

  it('emits a trace span per middleware invocation', async () => {
    const trace = new ArrayTrace();
    const r = new Registry().use(recorder('a', [])).use(recorder('b', []));
    await r.runPart(new Part(meta(), new Uint8Array()), trace);
    expect(trace.spans.map((s) => s.mw)).toEqual(['a', 'b']);
    expect(trace.spans.every((s) => s.status === 'ok')).toBe(true);
  });
});

describe('reference middleware via parse()', () => {
  it('charsetRepair: fixes a latin-1 text part mis-declared as utf-8', async () => {
    // charset=utf-8 but body has raw 0xE9 (latin-1 'é') → invalid utf-8 → replacement char.
    const head = new TextEncoder().encode(
      'Content-Type: text/plain; charset=utf-8\r\nContent-Transfer-Encoding: 8bit\r\n\r\nCaf',
    );
    const raw = new Uint8Array(head.length + 2);
    raw.set(head, 0);
    raw.set([0xe9, 0x0a], head.length); // é\n

    const plain = await parse(raw);
    expect(plain.text).toContain('�'); // unrepaired → replacement char

    const repaired = await parse(raw, { middleware: [charsetRepair()] });
    expect(repaired.text).not.toContain('�');
    expect(repaired.text).toContain('Café');
    expect(repaired.annotations['charsetRepaired']).toBeTruthy();
  });

  it('languageDetect: annotates ja on a Japanese body', async () => {
    const raw = new Uint8Array(readFileSync(`${DIR}/charset_japanese_utf8.eml`));
    const p = await parse(raw, { middleware: [languageDetect()] });
    expect(p.annotations['language']).toBe('ja');
  });

  it('winmailDetect: flags a TNEF body as attachment + annotates', async () => {
    const head = new TextEncoder().encode(
      'Content-Type: application/octet-stream\r\nContent-Transfer-Encoding: base64\r\n\r\n',
    );
    // base64 of the TNEF magic 78 9F 3E 22 + a couple bytes
    const b64 = new TextEncoder().encode(Buffer.from([0x78, 0x9f, 0x3e, 0x22, 0x01, 0x02]).toString('base64'));
    const raw = new Uint8Array(head.length + b64.length + 2);
    raw.set(head, 0);
    raw.set(b64, head.length);
    raw.set([0x0d, 0x0a], head.length + b64.length);

    const p = await parse(raw, { middleware: [winmailDetect()] });
    expect(p.attachments.length).toBe(1);
    expect(p.annotations['tnef']).toBe(true);
    expect(p.diagnostics.some((d) => d.code === 'TNEF_DETECTED')).toBe(true);
  });

  it('the full reference stack runs without disturbing the gold corpus', async () => {
    const raw = new Uint8Array(readFileSync(`${DIR}/mime_multipart_alt.eml`));
    const stack = [charsetRepair(), languageDetect(), winmailDetect()];
    const withMw = await parse(raw, { middleware: stack });
    const without = await parse(raw);
    // Same content channels + attachments; middleware only annotates here.
    expect((withMw.text ?? '').length).toBe((without.text ?? '').length);
    expect(withMw.attachments.length).toBe(without.attachments.length);
  });
});
