// Docs: docs/architecture/hot-loop-scoping.md
//
// The Wasm middleware adapter (hot-loop sub-phase 6.2, library half). Generated / community middleware
// must NOT run as trusted in-process code — they run as WebAssembly guests under a deny-by-default host
// with CPU/fuel/time budgets (Extism in production). This adapter makes such a guest satisfy the ordinary
// `Middleware` interface: it hands the guest a *data* description of the part and applies the *data*
// description it returns. The guest is a pure function of (meta, body) → changes; it has no network, no
// filesystem, no ambient authority — that's the whole security property, enforced by the host runtime.
//
// The host runtime is injected as a `WasmInvoker`, so this library stays runtime-agnostic (Extism/Wasmtime
// live in the platform, not in the OSS parser) and is fully testable with a stub invoker.

import type { MatchSpec } from '../match.js';
import type { Middleware, Part, Phase } from '../middleware.js';
import type { PartMeta } from '../types.js';

/** Per-invocation resource ceiling. Enforced by the host runtime; `timeoutMs` is also enforced here. */
export interface WasmBudget {
  timeoutMs?: number;
  /** Fuel/instruction budget passed through to the host runtime (Extism `Timeout`/fuel). */
  fuel?: number;
}

/** What the guest sees — a serializable projection of the part. No handles, no callbacks, no host refs. */
export interface WasmPartInput {
  meta: PartMeta;
  body: Uint8Array;
}

/** What the guest returns — a pure description of changes. Anything omitted is left unchanged. */
export interface WasmPartOutput {
  text?: string;
  html?: string;
  classifyAs?: 'attachment' | 'text' | 'html';
  /** Replacement decoded body. */
  body?: Uint8Array;
  /** Annotations merged into the part context (→ Message.annotations). */
  context?: Record<string, unknown>;
  diagnostics?: { code: string; severity: 'warn' | 'error'; detail?: string }[];
}

/** The host boundary. In production an Extism plugin; in tests a stub. MUST be a pure fn of `input`. */
export interface WasmInvoker {
  call(input: WasmPartInput, budget: WasmBudget): WasmPartOutput | Promise<WasmPartOutput>;
}

export interface WasmMiddlewareDef {
  name: string;
  phase: Phase;
  match: MatchSpec;
  invoker: WasmInvoker;
  budget?: WasmBudget;
  /** Provenance — recorded for the catalog; 'ai-generated' | 'community' | 'builtin'. */
  origin?: string;
}

class WasmTimeoutError extends Error {
  constructor(ms: number) {
    super(`wasm middleware exceeded ${ms}ms budget`);
    this.name = 'WasmTimeoutError';
  }
}

/** Race a promise against a wall-clock timeout (host-independent belt over the runtime's own fuel limit). */
async function withTimeout<T>(p: T | Promise<T>, ms: number | undefined): Promise<T> {
  if (!ms) return await p;
  let timer: ReturnType<typeof setTimeout>;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new WasmTimeoutError(ms)), ms);
  });
  try {
    return await Promise.race([Promise.resolve(p), timeout]);
  } finally {
    clearTimeout(timer!);
  }
}

/** Apply the guest's data-only output to the mutable Part. */
function applyOutput(part: Part, out: WasmPartOutput): void {
  if (out.body !== undefined) part.body = out.body;
  if (out.text !== undefined) part.text = out.text;
  if (out.html !== undefined) part.html = out.html;
  if (out.classifyAs !== undefined) part.classifyAs = out.classifyAs;
  if (out.context) Object.assign(part.context, out.context);
  if (out.diagnostics) {
    for (const d of out.diagnostics) {
      part.addDiagnostic({ code: d.code, severity: d.severity, scope: 'part', path: part.meta.path, ...(d.detail ? { detail: d.detail } : {}) });
    }
  }
}

/**
 * Wrap a sandboxed Wasm guest as a `Middleware`. A throwing/timing-out guest is contained by the Registry
 * (its error becomes a diagnostic and the chain recovers) — an untrusted plugin can never take the parser
 * down or escape its budget.
 */
export function wasmMiddleware(def: WasmMiddlewareDef): Middleware {
  return {
    name: def.name,
    phase: def.phase,
    match: def.match,
    async onPart(part, next) {
      const out = await withTimeout(
        def.invoker.call({ meta: part.meta, body: part.body }, def.budget ?? {}),
        def.budget?.timeoutMs,
      );
      applyOutput(part, out);
      await next();
    },
  };
}
