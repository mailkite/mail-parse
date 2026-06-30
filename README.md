<p align="center">
  <a href="https://mailkite.dev">
    <picture>
      <source media="(prefers-color-scheme: dark)" srcset="https://mailkite.dev/brand/logo-email-dark.png">
      <img src="https://mailkite.dev/brand/logo-email.png" alt="MailKite" height="56">
    </picture>
  </a>
</p>

<h1 align="center">MailKite mail-parse</h1>

<p align="center">
  <b>Streaming, memory-efficient, fully-typed MIME email parser</b> — byte chunks in, structured email out, with a declarative middleware seam.
  <br>The open-source parser behind <a href="https://mailkite.dev">MailKite</a>'s inbound pipeline.
</p>

<p align="center">
  <a href="https://mailkite.dev/docs">Docs</a> ·
  <a href="https://mailkite.dev/docs/libraries">Libraries</a> ·
  <a href="https://github.com/mailkite/mail-parse-py">Python port</a> ·
  <a href="https://mailkite.dev">mailkite.dev</a>
</p>
<p align="center"><a href="https://www.npmjs.com/package/@mailkite/mail-parse"><img src="https://img.shields.io/npm/v/@mailkite/mail-parse?color=2563eb&label=npm" alt="npm"></a> · <img src="https://img.shields.io/badge/license-MIT-2563eb" alt="MIT"></p>

> Maintained in the MailKite monorepo; this is the public home + npm distribution for `@mailkite/mail-parse`. Issues and PRs welcome here.

## Why

- **Streaming + low memory** — never buffers the whole message; the splitter holds at most **one part in flight** and attachments arrive part-by-part. (Contrast: most JS parsers buffer the entire message + every attachment.)
- **Fully typed** — strict TypeScript; the parsed `Message` shape is a single source of truth that ports across languages (see the [Python port](https://github.com/mailkite/mail-parse-py)).
- **Extensible by middleware, not forks** — a declarative-match registry handles unknown / malformed / special content (attachments, charsets, languages) **per part**, without editing the core.
- **Tolerant** — malformed input never throws; degradations surface as typed `diagnostics`.
- **Self-improving** — a deterministic, PII-free *failure-signature* primitive can auto-file deduplicated GitHub issues so the parser improves over time.

## Install

```bash
npm install @mailkite/mail-parse
```

## Quickstart

```ts
import { parse } from "@mailkite/mail-parse";

// From a Buffer/Uint8Array, a string, or any (async) iterable of byte chunks (a stream).
const msg = await parse(rawMimeBytes);

msg.from;        // { address, name? }
msg.subject;     // RFC 2047 decoded
msg.text;        // decoded text/plain
msg.html;        // decoded text/html
msg.attachments; // [{ filename, mimeType, content: Uint8Array, size, ... }]
msg.diagnostics; // typed, non-fatal degradations
```

### Middleware (handle odd content per-part)

```ts
import { parse, charsetRepair, languageDetect, winmailDetect } from "@mailkite/mail-parse";

const msg = await parse(rawMimeBytes, {
  middleware: [charsetRepair(), languageDetect(), winmailDetect()],
});
msg.annotations.language; // e.g. "ja"
```

### Stream attachments to a sink (lower-level)

```ts
import { splitMime } from "@mailkite/mail-parse";

await splitMime(readableStream, {
  onNodeStart(meta) {/* PartMeta computed before any per-part handling */},
  onBody(meta, chunk) {/* raw body bytes, part-by-part — pipe to R2/disk */},
  onNodeEnd(meta) {/* part finished */},
});
```

### Cloudflare Workers (buffered)

```ts
import { parseWithPostalMime } from "@mailkite/mail-parse/postal";
const msg = await parseWithPostalMime(rawMimeBytes); // same Message shape, Workers-native
```

## Develop

```bash
npm install
npm test          # vitest over the gold-standard corpus
npm run typecheck
npm run build
```

## All MailKite libraries

`mail-parse` is part of the MailKite ecosystem. The API SDKs (same contract, every language) live separately — full list: [https://mailkite.dev/docs/libraries](https://mailkite.dev/docs/libraries).

| Library | Repo | Distribution |
| --- | --- | --- |
| mail-parse **(this repo)** | [`mail-parse`](https://github.com/mailkite/mail-parse) | npm |
| mail-parse (Python port) | [`mail-parse-py`](https://github.com/mailkite/mail-parse-py) | PyPI |
| MailKite for Node.js | [`mailkite-node`](https://github.com/mailkite/mailkite-node) | npm |
| MailKite for Python | [`mailkite-python`](https://github.com/mailkite/mailkite-python) | PyPI |
| MailKite for Go | [`mailkite-go`](https://github.com/mailkite/mailkite-go) | Go modules |
| @mailkite/cli | [`mailkite-cli`](https://github.com/mailkite/mailkite-cli) | npm |
| @mailkite/mcp | [`mailkite-mcp`](https://github.com/mailkite/mailkite-mcp) | npm |

## Docs & links

- 📚 **Documentation:** https://mailkite.dev/docs
- 🧩 **Libraries:** https://mailkite.dev/docs/libraries
- 🐍 **Python port:** https://github.com/mailkite/mail-parse-py
- 🌐 **Website:** https://mailkite.dev

<sub>MIT licensed. © MailKite.</sub>
