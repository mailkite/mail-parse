// Docs: docs/architecture/mime-parser-implementation.md
//
// @mailkite/mail-parse — public entrypoint.
// Streaming, memory-efficient, fully-typed MIME parser. See docs/architecture/mime-parser.md
// for the design + decisions, and mime-parser-implementation.md for phase status.

export { parse, type ParseOptions } from './parse.js';
export { parseStream, type StreamHandlers } from './stream.js';
export { createTransferDecoder, type StreamingDecoder } from './stream-decode.js';
export { splitMime, type SplitHandlers } from './splitter.js';
export {
  Registry,
  Part,
  toRegistry,
  type Middleware,
  type Phase,
  type EmittedPart,
} from './middleware.js';
export { matches, specificity, type MatchSpec } from './match.js';
export {
  ArrayTrace,
  type TraceHook,
  type Span,
  type SpanRecord,
  type SpanEnd,
} from './trace.js';
export { charsetRepair, languageDetect, detectLanguage, winmailDetect } from './middlewares/index.js';
export {
  computeSignature,
  signaturesFromMessage,
  normalizeMailer,
  fnv1a64,
  FailureAggregator,
  ConsoleReporter,
  HttpReporter,
  GitHubIssueReporter,
  FailureSink,
  skeletonize,
  minimizeFailure,
  type FailureSignature,
  type FailureFeatures,
  type FailureEvent,
  type SignatureRollup,
  type AggregatorOptions,
  type FailureReport,
  type FailureReporter,
  type GitHubIssueReporterOptions,
  type ScrubbedSample,
  type FailureOracle,
} from './failure/index.js';
export { readLines, toChunks, type Line, type ByteSource } from './line-reader.js';
export {
  decodeBase64,
  decodeQuotedPrintable,
  decodeTransfer,
  decodeCharset,
} from './decode.js';
export {
  parseAddressList,
  parseSingleAddress,
  parseStructuredField,
  parseHeaderBlock,
  decodeEncodedWords,
  getHeader,
} from './headers.js';
export type {
  Address,
  Attachment,
  Diagnostic,
  DiagnosticScope,
  Header,
  Message,
  PartMeta,
} from './types.js';
