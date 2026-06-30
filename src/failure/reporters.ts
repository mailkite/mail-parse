// Docs: docs/architecture/mime-parser-implementation.md
//
// Failure sinks (mime-parser.md §8.0/§8.2). The library NEVER hardcodes GitHub — the deployer wires
// a reporter. Console/Http/GitHub are portable (global fetch, Workers-safe); FileReporter (node) lives
// in reporters-node.ts. The GitHub reporter is the cold loop: it embeds a hidden `parse-signature:`
// marker and search-then-creates, so N deployments hitting one bug converge on ONE idempotent issue.

import type { FailureReport } from './aggregator.js';

export interface FailureReporter {
  report(r: FailureReport): Promise<void> | void;
}

/** Default sink — logs a structured line. No bytes/PII (the signature is structural). */
export class ConsoleReporter implements FailureReporter {
  constructor(private readonly log: (msg: string) => void = console.warn) {}
  report(r: FailureReport): void {
    this.log(
      `[mail-parse] failure ${r.signature.hash} ×${r.count} (${r.distinctSources} sources) ` +
        `scope=${r.signature.features.scope} codes=${r.signature.features.diagnosticCodes.join(',')}`,
    );
  }
}

/** POST the report to a collector endpoint (e.g. a central dedup service that opens one issue). */
export class HttpReporter implements FailureReporter {
  constructor(
    private readonly url: string,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}
  async report(r: FailureReport): Promise<void> {
    await this.fetchImpl(this.url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(r),
    });
  }
}

export interface GitHubIssueReporterOptions {
  /** "owner/repo", e.g. "mailkite/mail-parse". */
  repo: string;
  /** A token with `issues:write`. */
  token: string;
  /** Label applied to every auto-filed issue. Default "parse-failure". */
  label?: string;
  fetchImpl?: typeof fetch;
  apiBase?: string;
}

/**
 * Opens (or increments) a deduplicated GitHub issue per signature. The hidden marker
 * `parse-signature: <hash>` in the body is the idempotency key: search finds an existing issue and
 * comments; otherwise a new one is created. AI-free — a separate responder (Action / human) fixes core.
 */
export class GitHubIssueReporter implements FailureReporter {
  private readonly label: string;
  private readonly fetchImpl: typeof fetch;
  private readonly apiBase: string;

  constructor(private readonly opts: GitHubIssueReporterOptions) {
    this.label = opts.label ?? 'parse-failure';
    this.fetchImpl = opts.fetchImpl ?? fetch;
    this.apiBase = opts.apiBase ?? 'https://api.github.com';
  }

  private headers(): Record<string, string> {
    return {
      authorization: `Bearer ${this.opts.token}`,
      accept: 'application/vnd.github+json',
      'content-type': 'application/json',
      'user-agent': 'mailkite-mail-parse',
    };
  }

  static marker(hash: string): string {
    return `parse-signature: ${hash}`;
  }

  async report(r: FailureReport): Promise<void> {
    const hash = r.signature.hash;
    const marker = GitHubIssueReporter.marker(hash);

    // Search for an existing issue carrying this signature marker.
    const q = encodeURIComponent(`repo:${this.opts.repo} in:body "${marker}" type:issue`);
    const found = await this.fetchImpl(`${this.apiBase}/search/issues?q=${q}`, { headers: this.headers() });
    const data = (await found.json()) as { total_count?: number; items?: { number: number }[] };

    if (data.total_count && data.items && data.items.length > 0) {
      const number = data.items[0]!.number;
      await this.fetchImpl(`${this.apiBase}/repos/${this.opts.repo}/issues/${number}/comments`, {
        method: 'POST',
        headers: this.headers(),
        body: JSON.stringify({
          body: `Seen again: ×${r.count} occurrences across ${r.distinctSources} source(s) in window.`,
        }),
      });
      return;
    }

    await this.fetchImpl(`${this.apiBase}/repos/${this.opts.repo}/issues`, {
      method: 'POST',
      headers: this.headers(),
      body: JSON.stringify({
        title: this.title(r),
        labels: [this.label],
        body: this.body(r, marker),
      }),
    });
  }

  private title(r: FailureReport): string {
    const f = r.signature.features;
    const what = f.contentType ?? f.structurePath ?? f.scope;
    return `Parse failure: ${f.diagnosticCodes.join(', ')} on ${what}`;
  }

  private body(r: FailureReport, marker: string): string {
    const f = r.signature.features;
    const rows = [
      ['scope', f.scope],
      ['diagnostics', f.diagnosticCodes.join(', ')],
      ['content-type', f.contentType ?? '—'],
      ['transfer-encoding', f.transferEncoding ?? '—'],
      ['byte-signature', f.byteSignature ?? '—'],
      ['mailer', f.mailerFamily ?? '—'],
      ['structure', f.structurePath ?? '—'],
      ['lib', f.libVersion],
      ['occurrences', `×${r.count} (${r.distinctSources} source(s))`],
    ];
    const table = rows.map(([k, v]) => `| ${k} | ${v} |`).join('\n');
    const roll = r.signature.rollup.map((x) => `\`${x.level}=${x.hash}\``).join(' · ');
    return [
      'Automatically filed by `@mailkite/mail-parse` — a message failed to parse.',
      '',
      '| field | value |',
      '| --- | --- |',
      table,
      '',
      `**Roll-up:** ${roll}`,
      '',
      'No message content is included (the signature is structural/PII-free). Attach a minimized,',
      'scrubbed repro to reproduce locally.',
      '',
      `<!-- ${marker} -->`,
    ].join('\n');
  }
}
