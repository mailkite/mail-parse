// Docs: docs/architecture/mime-parser-implementation.md
import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { parseWithPostalMime } from '../src/adapters/postal-mime.js';
import { parse } from '../src/parse.js';

const DIR = fileURLToPath(new URL('./fixtures/eml', import.meta.url));
const files = readdirSync(DIR).filter((f) => f.endsWith('.eml')).sort();

describe('postal-mime adapter → shared Message shape', () => {
  for (const file of files) {
    const name = file.replace('.eml', '');
    it(`parses ${name} into the Message shape`, async () => {
      const raw = new Uint8Array(readFileSync(`${DIR}/${file}`));
      const m = await parseWithPostalMime(raw);
      expect(Array.isArray(m.headers)).toBe(true);
      expect(Array.isArray(m.attachments)).toBe(true);
      expect(Array.isArray(m.diagnostics)).toBe(true);
      expect(typeof m.annotations).toBe('object');
      expect(typeof (m.subject ?? '')).toBe('string');
    });
  }

  it('agrees with the streaming core on key fields (plain_basic)', async () => {
    const raw = new Uint8Array(readFileSync(`${DIR}/plain_basic.eml`));
    const a = await parseWithPostalMime(raw);
    const b = await parse(raw);
    expect(a.from?.address).toBe(b.from?.address);
    expect(a.subject).toBe(b.subject);
    expect((a.text ?? '').trim()).toContain('Plain email.');
  });

  it('agrees on attachment count for a base64 attachment', async () => {
    const raw = new Uint8Array(readFileSync(`${DIR}/attach_pdf_base64.eml`));
    const a = await parseWithPostalMime(raw);
    const b = await parse(raw);
    expect(a.attachments.length).toBe(b.attachments.length);
    expect(a.attachments[0]!.size).toBeGreaterThan(0);
  });
});
