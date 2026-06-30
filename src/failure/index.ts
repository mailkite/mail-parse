// Docs: docs/architecture/mime-parser-implementation.md
// Portable failure-loop surface (mime-parser.md §8). FileReporter (node-only) is at ./reporters-node.
export {
  computeSignature,
  signaturesFromMessage,
  normalizeMailer,
  fnv1a64,
  type FailureSignature,
  type FailureFeatures,
  type FailureEvent,
  type SignatureRollup,
} from './signature.js';
export { FailureAggregator, type AggregatorOptions, type FailureReport } from './aggregator.js';
export {
  ConsoleReporter,
  HttpReporter,
  GitHubIssueReporter,
  type FailureReporter,
  type GitHubIssueReporterOptions,
} from './reporters.js';
export { FailureSink } from './sink.js';
export { skeletonize, minimizeFailure, type ScrubbedSample, type FailureOracle } from './scrub.js';
