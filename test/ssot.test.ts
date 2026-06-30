// Docs: docs/architecture/mime-parser-implementation.md
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
// @ts-expect-error — plain JS generator, no types needed for the drift check.
import { generate } from '../scripts/gen.mjs';

const read = (p: string) => readFileSync(fileURLToPath(new URL(`../${p}`, import.meta.url)), 'utf8');

describe('JTD SSOT codegen', () => {
  const jtd = JSON.parse(read('schema/models.jtd.json'));
  const out = generate(jtd);

  it('gen/ts/models.ts is up to date (run `npm run gen` if this fails)', () => {
    expect(out.ts).toBe(read('gen/ts/models.ts'));
  });
  it('gen/python/models.py is up to date (run `npm run gen` if this fails)', () => {
    expect(out.python).toBe(read('gen/python/models.py'));
  });
  it('emits the core JSON-facing models', () => {
    expect(out.ts).toContain('export interface ParsedMessage');
    expect(out.ts).toContain('export interface FailureSignature');
    expect(out.python).toContain('class FailureSignature:');
  });
});
