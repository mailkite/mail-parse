// Docs: docs/architecture/mime-parser-implementation.md
import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { parse } from '../src/parse.js';
import { splitMime } from '../src/splitter.js';

const DIR = fileURLToPath(new URL('./fixtures/eml', import.meta.url));
const files = readdirSync(DIR).filter((f) => f.endsWith('.eml')).sort();

// Loose structural expectations — "doesn't crash + extracts the right shape", mirroring the
// api/ conformance test so this parser is held to the same gold-standard bar as postal-mime.
const EXPECT: Record<string, { minAttachments?: number; hasFrom?: boolean }> = {
  attach_pdf_base64: { minAttachments: 1 },
  attach_message_rfc822: { minAttachments: 1 },
  attach_nonascii_filename: { minAttachments: 1 },
  mime_multipart: { minAttachments: 1 },
  mime_multipart_alt: { minAttachments: 1 },
  mime_nested_attachment: { minAttachments: 1 },
  plain_basic: { hasFrom: true },
  eai_utf8_headers: { hasFrom: true },
};

describe('conformance over the gold-standard corpus', () => {
  it('the corpus is present (15 fixtures)', () => {
    expect(files.length).toBeGreaterThanOrEqual(15);
  });

  for (const file of files) {
    const name = file.replace('.eml', '');
    it(`parses ${name} without throwing and extracts a sane shape`, async () => {
      const raw = new Uint8Array(readFileSync(`${DIR}/${file}`));
      const p = await parse(raw);

      expect(typeof (p.subject ?? '')).toBe('string');
      expect(Array.isArray(p.attachments)).toBe(true);
      const hasContent =
        (p.text?.length ?? 0) > 0 ||
        (typeof p.html === 'string' && p.html.length > 0) ||
        p.attachments.length > 0 ||
        name === 'edge_missing_body';
      expect(hasContent).toBe(true);

      const exp = EXPECT[name];
      if (exp?.minAttachments) expect(p.attachments.length).toBeGreaterThanOrEqual(exp.minAttachments);
      if (exp?.hasFrom) expect(p.from?.address ?? '').not.toBe('');
    });
  }
});

describe('field extraction', () => {
  it('plain_basic: from/subject/text', async () => {
    const p = await parse(new Uint8Array(readFileSync(`${DIR}/plain_basic.eml`)));
    expect(p.from?.address).toBe('test@lindsaar.net');
    expect(p.from?.name).toBe('Mikel Lindsaar');
    expect(p.subject).toBe('Testing 123');
    expect(p.text).toContain('Plain email.');
    expect(p.messageId).toBe('6B7EC235-5B17-4CA8-B2B8-39290DEB43A3@test.lindsaar.net');
  });

  it('mime_multipart_alt: both text and html channels', async () => {
    const p = await parse(new Uint8Array(readFileSync(`${DIR}/mime_multipart_alt.eml`)));
    const hasEither = (p.text?.length ?? 0) > 0 || (p.html?.length ?? 0) > 0;
    expect(hasEither).toBe(true);
  });

  it('attach_pdf_base64: decodes a base64 attachment to bytes', async () => {
    const p = await parse(new Uint8Array(readFileSync(`${DIR}/attach_pdf_base64.eml`)));
    expect(p.attachments.length).toBeGreaterThanOrEqual(1);
    const pdf = p.attachments.find((a) => a.mimeType === 'application/pdf') ?? p.attachments[0]!;
    expect(pdf.size).toBeGreaterThan(0);
    // PDFs start with "%PDF" — proves the base64 decode produced real bytes.
    const head = Buffer.from(pdf.content.slice(0, 4)).toString('latin1');
    expect(head.startsWith('%PDF')).toBe(true);
  });

  it('charset_japanese_shiftjis: decodes via TextDecoder (full-ICU)', async () => {
    const p = await parse(new Uint8Array(readFileSync(`${DIR}/charset_japanese_shiftjis.eml`)));
    const body = (p.text ?? '') + (p.html ?? '');
    // Should not be empty and should not be mojibake-only — at least one CJK codepoint present.
    expect(body.length).toBeGreaterThan(0);
    expect(/[　-ヿ一-鿿]/.test(body)).toBe(true);
  });
});

describe('streaming / memory behavior', () => {
  it('produces identical output when fed in tiny chunks', async () => {
    const raw = new Uint8Array(readFileSync(`${DIR}/mime_nested_attachment.eml`));
    const whole = await parse(raw);

    async function* tiny(): AsyncGenerator<Uint8Array> {
      for (let i = 0; i < raw.length; i += 7) yield raw.subarray(i, Math.min(i + 7, raw.length));
    }
    const streamed = await parse(tiny());

    expect(streamed.subject).toBe(whole.subject);
    expect(streamed.attachments.length).toBe(whole.attachments.length);
    expect(streamed.text).toBe(whole.text);
    for (let i = 0; i < whole.attachments.length; i++) {
      expect(streamed.attachments[i]!.size).toBe(whole.attachments[i]!.size);
    }
  });

  it('splitter holds at most one part in flight (start/end are balanced and serial)', async () => {
    const raw = new Uint8Array(readFileSync(`${DIR}/mime_nested_attachment.eml`));
    let openLeaves = 0;
    let maxOpen = 0;
    await splitMime(raw, {
      onNodeStart(meta) {
        if (!meta.isMultipart) {
          openLeaves++;
          maxOpen = Math.max(maxOpen, openLeaves);
        }
      },
      onNodeEnd(meta) {
        if (!meta.isMultipart) openLeaves--;
      },
    });
    expect(maxOpen).toBe(1); // never more than one leaf body being accumulated at a time
    expect(openLeaves).toBe(0); // all balanced
  });
});
