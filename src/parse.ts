// Docs: docs/architecture/mime-parser-implementation.md
//
// The convenience parser: drives the streaming splitter and assembles a typed Message (buffered
// result). The splitter is the genuinely-streaming primitive; this layer collects leaf bodies.
// When `options.middleware` is given, each decoded leaf runs through the registry (mime-parser.md
// §4) before classification. For large attachments a caller can use splitMime() directly and
// stream each part's onBody chunks to a sink (R2) instead of buffering — see Phase 1 follow-ups.

import { decodeCharset, decodeTransfer } from './decode.js';
import {
  decodeEncodedWords,
  getHeader,
  parseAddressList,
  parseSingleAddress,
} from './headers.js';
import { Part, Registry, toRegistry, type Middleware } from './middleware.js';
import { splitMime } from './splitter.js';
import type { TraceHook } from './trace.js';
import type { Attachment, Diagnostic, Header, Message, PartMeta } from './types.js';

export interface ParseOptions {
  /** Middleware to run per part (mime-parser.md §4). An array is wrapped into a Registry. */
  middleware?: Middleware[] | Registry;
  /** Per-middleware tracing hook. */
  trace?: TraceHook;
}

interface LeafCollector {
  meta: PartMeta;
  chunks: Uint8Array[];
  size: number;
}

/** Accumulators built up as leaves are classified. */
interface Acc {
  text: string | null;
  html: string | null;
  attachments: Attachment[];
  diagnostics: Diagnostic[];
}

/** Parse a raw MIME message into a typed Message. Never throws on malformed input — collects diagnostics. */
export async function parse(
  source: AsyncIterable<Uint8Array> | Iterable<Uint8Array> | Uint8Array | string,
  options: ParseOptions = {},
): Promise<Message> {
  let rootHeaders: Header[] | null = null;
  const leaves: LeafCollector[] = [];
  const open = new Map<PartMeta, LeafCollector>();
  const diagnostics: Diagnostic[] = [];

  await splitMime(source, {
    onNodeStart(meta) {
      if (rootHeaders === null) rootHeaders = meta.headers;
      if (!meta.isMultipart) open.set(meta, { meta, chunks: [], size: 0 });
    },
    onBody(meta, chunk) {
      const c = open.get(meta);
      if (c) {
        c.chunks.push(chunk);
        c.size += chunk.length;
      }
    },
    onNodeEnd(meta) {
      const c = open.get(meta);
      if (c) {
        open.delete(meta);
        leaves.push(c);
      }
    },
    onDiagnostic(d) {
      diagnostics.push(d);
    },
  });

  const registry = toRegistry(options.middleware);
  const acc: Acc = { text: null, html: null, attachments: [], diagnostics };
  const annotations: Record<string, unknown> = {};

  for (const leaf of leaves) {
    const body = decodeTransfer(concat(leaf.chunks, leaf.size), leaf.meta.encoding);
    if (registry) {
      const part = new Part(leaf.meta, body);
      await registry.runPart(part, options.trace);
      for (const d of part.diagnostics) diagnostics.push(d);
      Object.assign(annotations, part.context);
      ingestPart(part, acc);
    } else {
      classify(leaf.meta, body, acc);
    }
  }

  const headers = rootHeaders ?? [];
  const messageId = getHeader(headers, 'message-id')?.replace(/^<|>$/g, '') ?? null;
  const subjectRaw = getHeader(headers, 'subject');
  const from = parseSingleAddress(getHeader(headers, 'from'));

  return {
    headers,
    ...(from ? { from } : {}),
    to: parseAddressList(getHeader(headers, 'to')),
    cc: parseAddressList(getHeader(headers, 'cc')),
    bcc: parseAddressList(getHeader(headers, 'bcc')),
    replyTo: parseAddressList(getHeader(headers, 'reply-to')),
    subject: subjectRaw != null ? decodeEncodedWords(subjectRaw) : null,
    messageId,
    inReplyTo: getHeader(headers, 'in-reply-to')?.replace(/^<|>$/g, '') ?? null,
    date: getHeader(headers, 'date') ?? null,
    text: acc.text,
    html: acc.html,
    attachments: acc.attachments,
    diagnostics,
    annotations,
  };
}

/** Fold a middleware-processed part into the accumulators, honoring its overrides. */
function ingestPart(part: Part, acc: Acc): void {
  if (part.emitted.length) {
    for (const e of part.emitted) classify(e.meta, e.body, acc);
    return;
  }
  if (part.text !== undefined) {
    acc.text = (acc.text ?? '') + part.text;
    return;
  }
  if (part.html !== undefined) {
    acc.html = (acc.html ?? '') + part.html;
    return;
  }
  if (part.classifyAs === 'attachment') {
    acc.attachments.push(toAttachment(part.meta, part.body));
    return;
  }
  classify(part.meta, part.body, acc);
}

/** Default classification: inline text/* → a text channel; everything else → an attachment. */
function classify(meta: PartMeta, body: Uint8Array, acc: Acc): void {
  if (isBodyText(meta)) {
    const { text: str, ok } = decodeCharset(body, meta.charset);
    if (!ok) {
      acc.diagnostics.push({
        code: 'UNKNOWN_CHARSET',
        severity: 'warn',
        scope: 'part',
        path: meta.path,
        detail: `charset "${meta.charset}" not supported by runtime; decoded as utf-8`,
      });
    }
    if (meta.contentType === 'text/html') acc.html = (acc.html ?? '') + str;
    else acc.text = (acc.text ?? '') + str;
  } else {
    acc.attachments.push(toAttachment(meta, body));
  }
}

function toAttachment(meta: PartMeta, body: Uint8Array): Attachment {
  return {
    filename: meta.filename ?? null,
    mimeType: meta.contentType,
    disposition: meta.disposition ?? null,
    contentId: meta.contentId ?? null,
    content: body,
    size: body.length,
  };
}

/** A part is body text if it's text/* shown inline (no filename, not an explicit attachment). */
function isBodyText(meta: PartMeta): boolean {
  return meta.mainType === 'text' && !meta.filename && meta.disposition !== 'attachment';
}

function concat(chunks: Uint8Array[], total: number): Uint8Array {
  if (chunks.length === 1) return chunks[0]!;
  const out = new Uint8Array(total);
  let off = 0;
  for (const c of chunks) {
    out.set(c, off);
    off += c.length;
  }
  return out;
}
