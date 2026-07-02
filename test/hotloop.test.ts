// Docs: docs/architecture/hot-loop-scoping.md
//
// The fenced hot-loop substrate: gates as the sole approval authority, the sandboxed Wasm adapter, and the
// canary reducer. These tests are the security argument in code — an over-broad or non-fixing "fix" must
// be rejected by gates the candidate's author never wrote.

import { describe, it, expect } from 'vitest';
import type { Middleware } from '../src/middleware.js';
import { parse } from '../src/parse.js';
import {
  advanceCanary,
  disabled,
  evaluateCandidate,
  gateGolden,
  initialCanary,
  sealFixture,
  trafficFraction,
  wasmMiddleware,
  type BenignSample,
  type WasmInvoker,
} from '../src/hotloop/index.js';

const enc = (s: string) => new TextEncoder().encode(s);

// A message whose text/plain part declares a charset the runtime can't decode → UNKNOWN_CHARSET.
const FAILING = enc('Content-Type: text/plain; charset=x-unknown-42\r\n\r\nhello world\r\n');

const BENIGN: BenignSample[] = [
  { id: 'utf8', raw: enc('Content-Type: text/plain; charset=utf-8\r\n\r\nhi there\r\n') },
  { id: 'html', raw: enc('Content-Type: text/html; charset=utf-8\r\n\r\n<p>hi</p>\r\n') },
  {
    id: 'mixed',
    raw: enc(
      'Content-Type: multipart/mixed; boundary=b\r\n\r\n--b\r\nContent-Type: text/plain\r\n\r\nbody\r\n--b--\r\n',
    ),
  },
];

// A GOOD fix: narrow (contentType + charset) and it resolves the failure by claiming a text channel.
const goodFix: Middleware = {
  name: 'repair-x-unknown-42',
  phase: 'decode',
  match: { contentType: 'text/plain', charset: 'x-unknown-42' },
  async onPart(part, next) {
    part.text = new TextDecoder('utf-8').decode(part.body);
    await next();
  },
};

// An OVER-BROAD fix: fires on all text and corrupts it. Must be rejected by the gates.
const overBroadFix: Middleware = {
  name: 'greedy',
  phase: 'decode',
  match: { maintype: 'text' },
  async onPart(part, next) {
    part.text = 'CORRUPTED';
    await next();
  },
};

// A NARROW-but-USELESS fix: specific enough, no-ops on benign, but doesn't resolve the failure.
const noopFix: Middleware = {
  name: 'lazy',
  phase: 'decode',
  match: { contentType: 'text/plain', charset: 'x-unknown-42' },
  async onPart(_part, next) {
    await next();
  },
};

describe('gate battery — the auto-approval authority', () => {
  it('confirms the fixture actually fails on the reference parser', async () => {
    const fixture = await sealFixture('fx1', FAILING, 'deadbeef00000000');
    expect(fixture.failingCodes).toContain('UNKNOWN_CHARSET');
  });

  it('APPROVES a narrow fix that resolves the failure and no-ops elsewhere', async () => {
    const fixture = await sealFixture('fx1', FAILING, 'deadbeef00000000');
    const verdict = await evaluateCandidate(goodFix, { fixture, benignCorpus: BENIGN });
    expect(verdict.approved).toBe(true);
    expect(verdict.results.every((r) => r.passed)).toBe(true);
  });

  it('REJECTS an over-broad fix (specificity floor + benign zero-fire + identity all catch it)', async () => {
    const fixture = await sealFixture('fx1', FAILING, 'deadbeef00000000');
    const verdict = await evaluateCandidate(overBroadFix, { fixture, benignCorpus: BENIGN });
    expect(verdict.approved).toBe(false);
    const failed = verdict.results.filter((r) => !r.passed).map((r) => r.gate);
    expect(failed).toContain('specificity');
    expect(failed).toContain('benign-zero-fire');
    expect(failed).toContain('identity');
  });

  it('REJECTS a narrow fix that does not actually resolve the failure (golden gate)', async () => {
    const fixture = await sealFixture('fx1', FAILING, 'deadbeef00000000');
    const verdict = await evaluateCandidate(noopFix, { fixture, benignCorpus: BENIGN });
    expect(verdict.approved).toBe(false);
    const golden = verdict.results.find((r) => r.gate === 'golden')!;
    expect(golden.passed).toBe(false);
  });

  it('golden gate rejects a fix that introduces a new error even if it clears the target', async () => {
    const fixture = await sealFixture('fx1', FAILING, 'deadbeef00000000');
    const buggy: Middleware = {
      name: 'introduces-error',
      phase: 'decode',
      match: { contentType: 'text/plain', charset: 'x-unknown-42' },
      async onPart(part, next) {
        part.text = 'ok';
        part.addDiagnostic({ code: 'BOOM', severity: 'error', scope: 'part' });
        await next();
      },
    };
    const result = await gateGolden(buggy, fixture);
    expect(result.passed).toBe(false);
    expect(result.detail).toContain('BOOM');
  });
});

describe('sandboxed Wasm middleware adapter', () => {
  it('applies a guest data-output to the part', async () => {
    const invoker: WasmInvoker = { call: () => ({ text: 'FROM_WASM', context: { lang: 'xx' } }) };
    const mw = wasmMiddleware({
      name: 'wasm-tagger',
      phase: 'enrich',
      match: { maintype: 'text' },
      invoker,
    });
    const msg = await parse('Content-Type: text/plain\r\n\r\noriginal\r\n', { middleware: [mw] });
    expect(msg.text).toBe('FROM_WASM');
    expect(msg.annotations.lang).toBe('xx');
  });

  it('contains a guest that blows its time budget (parse still succeeds, error becomes a diagnostic)', async () => {
    const slow: WasmInvoker = {
      call: () => new Promise((r) => setTimeout(() => r({ text: 'late' }), 50)),
    };
    const mw = wasmMiddleware({
      name: 'wasm-slow',
      phase: 'enrich',
      match: { maintype: 'text' },
      invoker: slow,
      budget: { timeoutMs: 5 },
    });
    const msg = await parse('Content-Type: text/plain\r\n\r\nx\r\n', { middleware: [mw] });
    expect(msg.diagnostics.some((d) => d.code === 'MIDDLEWARE_ERROR')).toBe(true);
    expect(msg.text).toBe('x\r\n'); // fell back to the normal channel, not corrupted
  });

  it('a Wasm candidate is gated exactly like a native one', async () => {
    const fixture = await sealFixture('fx1', FAILING, 'deadbeef00000000');
    const wasmFix = wasmMiddleware({
      name: 'wasm-repair',
      phase: 'decode',
      match: { contentType: 'text/plain', charset: 'x-unknown-42' },
      invoker: { call: (input) => ({ text: new TextDecoder('utf-8').decode(input.body) }) },
    });
    const verdict = await evaluateCandidate(wasmFix, { fixture, benignCorpus: BENIGN });
    expect(verdict.approved).toBe(true);
  });
});

describe('canary rollout reducer', () => {
  const healthy = { parseSuccessDelta: 0, errors: 0 };

  it('graduates shadow → 5% → 25% → 100% on healthy rounds', () => {
    let s = initialCanary();
    expect(s.stage).toBe('shadow');
    s = advanceCanary(s, healthy);
    expect(s.stage).toBe('canary_5');
    s = advanceCanary(s, healthy);
    expect(s.stage).toBe('canary_25');
    s = advanceCanary(s, healthy);
    expect(s.stage).toBe('live_100');
    expect(trafficFraction(s.stage)).toBe(1);
  });

  it('auto-rolls-back to disabled on a regression or error', () => {
    let s = advanceCanary(initialCanary(), healthy); // canary_5
    s = advanceCanary(s, { parseSuccessDelta: -0.01, errors: 0 });
    expect(s.stage).toBe('disabled');
    expect(trafficFraction(s.stage)).toBe(0);

    let t = advanceCanary(initialCanary(), healthy);
    t = advanceCanary(t, { parseSuccessDelta: 0, errors: 3 });
    expect(t.stage).toBe('disabled');
  });

  it('respects a slower promotion policy (N healthy rounds per stage)', () => {
    let s = initialCanary();
    s = advanceCanary(s, healthy, { promoteAfterHealthyRounds: 2 });
    expect(s.stage).toBe('shadow'); // 1 healthy round, needs 2
    s = advanceCanary(s, healthy, { promoteAfterHealthyRounds: 2 });
    expect(s.stage).toBe('canary_5');
  });

  it('disabled is terminal (kill switch stays dead)', () => {
    expect(advanceCanary(disabled(), healthy).stage).toBe('disabled');
  });
});
