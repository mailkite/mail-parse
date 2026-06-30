# @mailkite/mail-parse

> Streaming, memory-efficient, fully-typed MIME email parser with a declarative middleware seam.

A from-scratch MIME parser in the [mailsplit](https://github.com/zone-eu/mailsplit) streaming model:
byte chunks in → structured node events out, holding **at most one part in flight**. Built for
[MailKite](https://mailkite.dev)'s inbound pipeline, but standalone and MIT.

**Status:** early — Phase 1 (streaming core) is implemented and passing the gold-standard corpus.
Design + roadmap live in the MailKite repo under `docs/architecture/mime-parser.md` (the "why") and
`mime-parser-implementation.md` (phase tracker).

## Why

- **Streaming + low memory** — never buffers the whole message; attachments are delivered part-by-part
  (vs. `postal-mime`, which buffers the entire message + every attachment into memory).
- **Fully typed** — strict TypeScript; data models come from a JSON-schema SSOT (multi-language ports planned).
- **Extensible by middleware, not forks** — a declarative-match registry (Phase 2) lets you handle
  unknown/odd/broken content per-part without editing the core.
- **Tolerant** — malformed input never throws; degradations are collected as typed `Diagnostic`s.

## Usage

```ts
import { parse } from '@mailkite/mail-parse';

// From a Buffer/Uint8Array, a string, or any (async) iterable of byte chunks (a stream).
const msg = await parse(rawMimeBytes);

msg.from;        // { address, name? }
msg.subject;     // RFC 2047 decoded
msg.text;        // decoded text/plain
msg.html;        // decoded text/html
msg.attachments; // [{ filename, mimeType, content: Uint8Array, size, ... }]
msg.diagnostics; // typed, non-fatal degradations
```

### Streaming attachments to a sink (lower-level)

```ts
import { splitMime } from '@mailkite/mail-parse';

await splitMime(readableStream, {
  onNodeStart(meta) { /* PartMeta computed before any per-part handling */ },
  onBody(meta, chunk) { /* raw (still transfer-encoded) body bytes, part-by-part */ },
  onNodeEnd(meta) { /* part finished */ },
  onDiagnostic(d) { /* structural warnings */ },
});
```

## Develop

```sh
npm install
npm test          # vitest over the gold-standard corpus
npm run typecheck
npm run build
```

## License

MIT
