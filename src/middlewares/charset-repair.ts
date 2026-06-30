// Docs: docs/architecture/mime-parser-implementation.md
//
// Reference middleware (decode phase): re-decode a text part whose declared charset produces
// replacement characters (mojibake) by trying a small fallback ladder and keeping the cleanest.
// Only intervenes when the declared decode is actually broken; otherwise no-ops.

import { decodeCharset } from '../decode.js';
import type { Middleware } from '../middleware.js';

const FALLBACKS = ['windows-1252', 'iso-8859-1', 'utf-8'];

function replacementCount(s: string): number {
  let n = 0;
  for (const ch of s) if (ch === '�') n++;
  return n;
}

export function charsetRepair(): Middleware {
  return {
    name: 'mailkite-middleware-charset-repair',
    phase: 'decode',
    match: { maintype: 'text' },
    async onPart(part, next) {
      const declared = decodeCharset(part.body, part.meta.charset);
      const declaredBad = replacementCount(declared.text);
      if (declaredBad === 0) {
        await next();
        return;
      }
      let bestText = declared.text;
      let bestBad = declaredBad;
      let bestLabel = declared.label;
      for (const cs of FALLBACKS) {
        const t = decodeCharset(part.body, cs);
        const bad = replacementCount(t.text);
        if (bad < bestBad) {
          bestText = t.text;
          bestBad = bad;
          bestLabel = t.label;
        }
      }
      if (bestText !== declared.text) {
        if (part.meta.contentType === 'text/html') part.html = bestText;
        else part.text = bestText;
        part.context['charsetRepaired'] = bestLabel;
        part.addDiagnostic({
          code: 'CHARSET_REPAIRED',
          severity: 'warn',
          scope: 'part',
          path: part.meta.path,
          detail: `declared "${part.meta.charset ?? 'none'}" decoded with ${declaredBad} bad chars; re-decoded as ${bestLabel}`,
        });
      }
      await next();
    },
  };
}
