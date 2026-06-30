// Docs: docs/architecture/mime-parser-implementation.md
// Convenience: ties an aggregator to reporters and fans a fired report out to all of them.
import { FailureAggregator } from './aggregator.js';
import { signaturesFromMessage, type FailureSignature } from './signature.js';
import type { FailureReporter } from './reporters.js';
import type { Message } from '../types.js';

export class FailureSink {
  constructor(
    private readonly aggregator: FailureAggregator,
    private readonly reporters: FailureReporter[],
    private readonly source?: string,
  ) {}

  /** Observe one signature; if it crosses the threshold, report it to every reporter. */
  async observe(signature: FailureSignature, source = this.source): Promise<boolean> {
    const report = this.aggregator.observe(signature, source);
    if (!report) return false;
    await Promise.all(this.reporters.map((r) => r.report(report)));
    return true;
  }

  /** Derive failure signatures from a parsed Message's diagnostics and observe each. */
  async observeMessage(message: Message, source = this.source): Promise<number> {
    let fired = 0;
    for (const sig of signaturesFromMessage(message)) {
      if (await this.observe(sig, source)) fired++;
    }
    return fired;
  }
}
