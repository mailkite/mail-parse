// Docs: docs/architecture/hot-loop-scoping.md
//
// @mailkite/mail-parse/hotloop — the *fenced substrate* for the self-healing hot loop: sealed fixtures +
// replay, the adversarial gate battery (the auto-approval authority), the sandboxed Wasm-middleware
// adapter, and the canary rollout state machine. This is the "build the safe execution + gates + canary
// first; wire the generation agent into it last" half (hot-loop-scoping §3). The generation pipeline, R2
// fixture store, Cloudflare queue jobs, Extism host, signed-manifest distribution, and admin review page
// are platform concerns (api/) that consume this substrate — they are NOT in the OSS parser.

export { replay, sealFixture, type SealedFixture, type ReplayResult } from './fixture.js';
export {
  evaluateCandidate,
  gateSpecificity,
  gateBenignZeroFire,
  gateGolden,
  gateIdentity,
  type BenignSample,
  type GateResult,
  type CandidateVerdict,
  type GateOptions,
} from './gates.js';
export {
  wasmMiddleware,
  type WasmInvoker,
  type WasmMiddlewareDef,
  type WasmPartInput,
  type WasmPartOutput,
  type WasmBudget,
} from './wasm-middleware.js';
export {
  initialCanary,
  advanceCanary,
  disabled,
  trafficFraction,
  type CanaryStage,
  type CanaryState,
  type RolloutMetrics,
  type RolloutPolicy,
} from './canary.js';
