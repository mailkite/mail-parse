// Docs: docs/architecture/mime-parser-implementation.md
//
// Reference middleware (structure phase): detect Outlook TNEF (winmail.dat) by its magic number
// — content-type-agnostic, so it catches the common case where Outlook sends it as
// application/octet-stream. It annotates + flags the part as an attachment. FULL TNEF extraction
// (pulling the real attachments out of winmail.dat) is the marquee community plugin, not bundled
// here — this demonstrates byteSignature matching and the detect→annotate path. (mime-parser.md §8.5)

import type { Middleware } from '../middleware.js';

// TNEF signature 0x223E9F78, little-endian on the wire → bytes 78 9F 3E 22.
const TNEF_MAGIC = { offset: 0, hexPrefix: '789f3e22' };

export function winmailDetect(): Middleware {
  return {
    name: 'mailkite-middleware-winmail-detect',
    phase: 'structure',
    match: { byteSignature: TNEF_MAGIC },
    async onPart(part, next) {
      part.classifyAs = 'attachment';
      part.context['tnef'] = true;
      part.addDiagnostic({
        code: 'TNEF_DETECTED',
        severity: 'warn',
        scope: 'part',
        path: part.meta.path,
        detail: `winmail.dat (TNEF) detected${part.meta.filename ? ` as "${part.meta.filename}"` : ''}; contents not extracted (install a TNEF middleware)`,
      });
      await next();
    },
  };
}
