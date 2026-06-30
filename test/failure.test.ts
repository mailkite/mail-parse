// Docs: docs/architecture/mime-parser-implementation.md
import { describe, it, expect } from 'vitest';
import { computeSignature, signaturesFromMessage, normalizeMailer } from '../src/failure/signature.js';
import { FailureAggregator } from '../src/failure/aggregator.js';
import { GitHubIssueReporter, ConsoleReporter } from '../src/failure/reporters.js';
import { FailureSink } from '../src/failure/sink.js';
import { skeletonize, minimizeFailure } from '../src/failure/scrub.js';
import type { FailureEvent } from '../src/failure/signature.js';
import type { Message } from '../src/types.js';

const baseEvent: FailureEvent = {
  scope: 'part',
  diagnosticCodes: ['BOUNDARY_NOT_CLOSED'],
  contentType: 'application/ms-tnef',
  transferEncoding: 'base64',
};

describe('signature determinism + grouping', () => {
  it('is deterministic and order-independent over diagnostic codes', () => {
    const a = computeSignature({ ...baseEvent, diagnosticCodes: ['A', 'B'] });
    const b = computeSignature({ ...baseEvent, diagnosticCodes: ['B', 'A'] });
    expect(a.hash).toBe(b.hash);
  });

  it('different content-types produce different signatures', () => {
    const pdf = computeSignature({ ...baseEvent, contentType: 'application/pdf' });
    const tnef = computeSignature({ ...baseEvent, contentType: 'application/ms-tnef' });
    expect(pdf.hash).not.toBe(tnef.hash);
  });

  it('coarser roll-up collapses content-type differences at the scope level', () => {
    const pdf = computeSignature({ ...baseEvent, contentType: 'application/pdf' });
    const tnef = computeSignature({ ...baseEvent, contentType: 'application/ms-tnef' });
    const scopePdf = pdf.rollup.find((r) => r.level === 'scope')!.hash;
    const scopeTnef = tnef.rollup.find((r) => r.level === 'scope')!.hash;
    expect(scopePdf).toBe(scopeTnef); // same class at the coarse level
  });

  it('byte-signature comes from structure, not content', () => {
    const sig = computeSignature({ ...baseEvent, bodyHead: Uint8Array.of(0x78, 0x9f, 0x3e, 0x22) });
    expect(sig.features.byteSignature).toBe('789f3e22');
  });

  it('normalizes mailer families', () => {
    expect(normalizeMailer('Microsoft Outlook 16.0')).toBe('outlook');
    expect(normalizeMailer('Apple Mail (2.929.2)')).toBe('apple-mail');
  });

  it('derives signatures from a Message and includes no body content', () => {
    const msg = {
      headers: [{ key: 'X-Mailer', value: 'Apple Mail (2.929.2)' }],
      to: [],
      cc: [],
      bcc: [],
      replyTo: [],
      subject: 'secret subject',
      messageId: null,
      inReplyTo: null,
      date: null,
      text: 'private body text',
      html: null,
      attachments: [],
      diagnostics: [
        { code: 'UNKNOWN_CHARSET', severity: 'warn', scope: 'part', path: 'multipart/mixed>text/plain' },
      ],
      annotations: {},
    } satisfies Message;
    const sigs = signaturesFromMessage(msg);
    expect(sigs.length).toBe(1);
    const serialized = JSON.stringify(sigs[0]);
    expect(serialized).not.toContain('secret subject');
    expect(serialized).not.toContain('private body text');
    expect(sigs[0]!.features.mailerFamily).toBe('apple-mail');
  });
});

describe('aggregator windowing + thresholds', () => {
  it('fires only after threshold, then leaky-buckets', () => {
    let t = 1000;
    const agg = new FailureAggregator({ threshold: 3, windowMs: 10_000, reportCooldownMs: 10_000, now: () => t });
    const sig = computeSignature(baseEvent);
    expect(agg.observe(sig)).toBeNull(); // 1
    expect(agg.observe(sig)).toBeNull(); // 2
    const fired = agg.observe(sig); // 3 → fire
    expect(fired).not.toBeNull();
    expect(fired!.count).toBe(3);
    expect(agg.observe(sig)).toBeNull(); // cooldown
  });

  it('fires early when distinctSources crosses its threshold', () => {
    let t = 0;
    const agg = new FailureAggregator({ threshold: 100, distinctSourcesThreshold: 2, now: () => t });
    const sig = computeSignature(baseEvent);
    expect(agg.observe(sig, 'tenantA')).toBeNull();
    const fired = agg.observe(sig, 'tenantB');
    expect(fired).not.toBeNull();
    expect(fired!.distinctSources).toBe(2);
  });

  it('rolls old observations out of the window', () => {
    let t = 0;
    const agg = new FailureAggregator({ threshold: 3, windowMs: 100, now: () => t });
    const sig = computeSignature(baseEvent);
    agg.observe(sig);
    t = 50;
    agg.observe(sig);
    t = 200; // first obs now outside the 100ms window
    expect(agg.countOf(sig.hash)).toBe(0);
  });
});

describe('GitHubIssueReporter idempotency', () => {
  function fakeFetch(existing: boolean) {
    const calls: { url: string; method: string; body?: unknown }[] = [];
    const impl = (async (url: string, init?: RequestInit) => {
      calls.push({ url, method: init?.method ?? 'GET', body: init?.body ? JSON.parse(init.body as string) : undefined });
      if (url.includes('/search/issues')) {
        return new Response(
          JSON.stringify(existing ? { total_count: 1, items: [{ number: 42 }] } : { total_count: 0, items: [] }),
          { status: 200 },
        );
      }
      return new Response(JSON.stringify({ number: 99 }), { status: 201 });
    }) as unknown as typeof fetch;
    return { impl, calls };
  }

  const report = {
    signature: computeSignature(baseEvent),
    count: 5,
    distinctSources: 2,
    firstSeen: 0,
    lastSeen: 1,
  };

  it('creates a new issue with the hidden marker when none exists', async () => {
    const { impl, calls } = fakeFetch(false);
    await new GitHubIssueReporter({ repo: 'mailkite/mail-parse', token: 't', fetchImpl: impl }).report(report);
    const create = calls.find((c) => c.method === 'POST' && (c.url as string).endsWith('/issues'));
    expect(create).toBeTruthy();
    expect(JSON.stringify(create!.body)).toContain(`parse-signature: ${report.signature.hash}`);
  });

  it('comments instead of creating when the signature already has an issue', async () => {
    const { impl, calls } = fakeFetch(true);
    await new GitHubIssueReporter({ repo: 'mailkite/mail-parse', token: 't', fetchImpl: impl }).report(report);
    expect(calls.some((c) => (c.url as string).includes('/issues/42/comments'))).toBe(true);
    expect(calls.some((c) => (c.url as string).endsWith('/issues'))).toBe(false);
  });
});

describe('FailureSink wiring', () => {
  it('reports to all reporters when the aggregator fires', async () => {
    const seen: string[] = [];
    const agg = new FailureAggregator({ threshold: 1 });
    const sink = new FailureSink(agg, [
      { report: (r) => void seen.push(`a:${r.signature.hash}`) },
      new ConsoleReporter(() => {}),
    ]);
    const fired = await sink.observe(computeSignature(baseEvent));
    expect(fired).toBe(true);
    expect(seen.length).toBe(1);
  });
});

describe('deterministic scrub + minimize', () => {
  it('skeletonize keeps structure but removes readable words', () => {
    const raw = new TextEncoder().encode(
      'From: alice@example.com\r\nSubject: Secret plans\r\nContent-Type: text/plain; charset=utf-8\r\n\r\nMeet at noon\r\n',
    );
    const { bytes } = skeletonize(raw);
    const text = new TextDecoder().decode(bytes);
    expect(text).not.toContain('alice');
    expect(text).not.toContain('Secret');
    expect(text).not.toContain('Meet');
    expect(text).toContain('From:'); // header NAME kept
    expect(text).toContain('Content-Type: text/plain; charset=utf-8'); // structural header verbatim
  });

  it('minimizeFailure ddmin reduces to the lines the oracle needs', async () => {
    const raw = new TextEncoder().encode(
      ['keep-me', 'noise-1', 'noise-2', 'noise-3', 'noise-4'].map((l) => l + '\n').join(''),
    );
    const oracle = (cand: Uint8Array) => new TextDecoder().decode(cand).includes('keep-me');
    const min = await minimizeFailure(raw, oracle);
    const text = new TextDecoder().decode(min);
    expect(text).toContain('keep-me');
    expect(text.replace('keep-me', '').replace(/\s/g, '')).toBe(''); // only the needed line remains
  });
});
