// Docs: docs/architecture/mime-parser-implementation.md
//
// Cloudflare Workers adapter (mime-parser.md §3/§7). The streaming core targets Node (the Haraka MX
// edge); on Workers the canonical path is BUFFERED via postal-mime (zero-dep, MIT-0, Workers-native).
// This wraps it behind the SAME typed `Message` so callers are runtime-agnostic. It loses streaming
// (postal-mime buffers the whole message) — that trade-off is the whole reason this is the edge path.

import PostalMime from 'postal-mime';
import type { Address, Attachment, Header, Message } from '../types.js';

type PostalAddress = { address?: string; name?: string };

/** Parse via postal-mime and map to the shared `Message` shape. Buffered; Workers/browser-safe. */
export async function parseWithPostalMime(
  raw: Uint8Array | ArrayBuffer | string,
): Promise<Message> {
  const email = await PostalMime.parse(raw);

  const headers: Header[] = (email.headers ?? []).map((h) => ({ key: h.key, value: h.value }));
  const from = mapAddress(email.from);

  const attachments: Attachment[] = (email.attachments ?? []).map((a) => {
    const content = toUint8(a.content);
    return {
      filename: a.filename ?? null,
      mimeType: (a.mimeType ?? 'application/octet-stream').toLowerCase(),
      disposition: a.disposition === 'attachment' || a.disposition === 'inline' ? a.disposition : null,
      contentId: a.contentId ? a.contentId.replace(/^<|>$/g, '') : null,
      content,
      size: content.length,
    };
  });

  return {
    headers,
    ...(from ? { from } : {}),
    to: mapAddresses(email.to),
    cc: mapAddresses(email.cc),
    bcc: mapAddresses(email.bcc),
    replyTo: mapAddresses(email.replyTo),
    subject: email.subject ?? null,
    messageId: email.messageId ? email.messageId.replace(/^<|>$/g, '') : null,
    inReplyTo: email.inReplyTo ? email.inReplyTo.replace(/^<|>$/g, '') : null,
    date: email.date ?? null,
    text: email.text ?? null,
    html: email.html ?? null,
    attachments,
    diagnostics: [], // postal-mime doesn't surface structured diagnostics
    annotations: {},
  };
}

function mapAddress(a: PostalAddress | undefined): Address | undefined {
  if (!a || !a.address) return undefined;
  return { address: a.address, ...(a.name ? { name: a.name } : {}) };
}

function mapAddresses(list: PostalAddress[] | undefined): Address[] {
  if (!list) return [];
  return list.map((a) => ({ address: a.address ?? '', ...(a.name ? { name: a.name } : {}) })).filter((a) => a.address);
}

function toUint8(content: ArrayBuffer | Uint8Array | string): Uint8Array {
  if (typeof content === 'string') return new TextEncoder().encode(content);
  if (content instanceof Uint8Array) return content;
  return new Uint8Array(content);
}
