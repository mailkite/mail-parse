// Docs: docs/architecture/mime-parser-implementation.md
// Node-only reporter (uses node:fs). Kept out of the portable barrel so the Workers bundle stays clean.
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { FailureReport } from './aggregator.js';
import type { FailureReporter } from './reporters.js';

/** Writes one JSON file per signature (`<hash>.json`) into `dir`, overwritten with the latest count. */
export class FileReporter implements FailureReporter {
  constructor(private readonly dir: string) {}
  async report(r: FailureReport): Promise<void> {
    await mkdir(this.dir, { recursive: true });
    await writeFile(join(this.dir, `${r.signature.hash}.json`), JSON.stringify(r, null, 2));
  }
}
