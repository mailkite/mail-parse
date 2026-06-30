// Docs: docs/architecture/mime-parser-implementation.md
//
// Incremental line tokenizer. Consumes a stream of byte chunks and yields one line at a time,
// keeping only a small remainder buffer — it NEVER holds the whole message. Each line preserves
// its content bytes and its terminator separately, because MIME boundary matching needs the
// terminator-stripped content while body reconstruction needs the exact terminator.

/** One physical line: content bytes (no terminator) + the terminator that followed it. */
export interface Line {
  /** Line content without the trailing CR/LF. */
  bytes: Uint8Array;
  /** "\r\n" | "\n" | "" (last line, no terminator). */
  term: '\r\n' | '\n' | '';
}

const LF = 0x0a;
const CR = 0x0d;

/** Normalize any input form into an async iterable of byte chunks. */
export async function* toChunks(
  source: AsyncIterable<Uint8Array> | Iterable<Uint8Array> | Uint8Array | string,
): AsyncGenerator<Uint8Array> {
  if (typeof source === 'string') {
    yield new TextEncoder().encode(source);
    return;
  }
  if (source instanceof Uint8Array) {
    yield source;
    return;
  }
  if (Symbol.asyncIterator in source) {
    for await (const c of source as AsyncIterable<Uint8Array>) yield asBytes(c);
    return;
  }
  for (const c of source as Iterable<Uint8Array>) yield asBytes(c);
}

function asBytes(c: Uint8Array | string): Uint8Array {
  return typeof c === 'string' ? new TextEncoder().encode(c) : c;
}

/**
 * Yield lines from a chunk stream. Splits on LF; strips a preceding CR. Only a partial trailing
 * line is buffered between chunks, so memory stays O(longest line), not O(message).
 */
export async function* readLines(
  source: AsyncIterable<Uint8Array> | Iterable<Uint8Array> | Uint8Array | string,
): AsyncGenerator<Line> {
  let rem: Uint8Array = new Uint8Array(0);
  for await (const chunk of toChunks(source)) {
    const buf: Uint8Array = concat(rem, chunk);
    let start = 0;
    for (let i = 0; i < buf.length; i++) {
      if (buf[i] === LF) {
        const hasCR = i > start && buf[i - 1] === CR;
        const end = hasCR ? i - 1 : i;
        // .slice() (copy), not .subarray() (view): the splitter retains lines across pulls
        // (`pending`, `headerLines`), so a buffer-reusing source must not alias our bytes.
        yield { bytes: buf.slice(start, end), term: hasCR ? '\r\n' : '\n' };
        start = i + 1;
      }
    }
    rem = buf.subarray(start);
    // Detach the remainder from the (possibly large) chunk so it can be GC'd.
    rem = rem.length ? rem.slice() : new Uint8Array(0);
  }
  if (rem.length) yield { bytes: rem, term: '' };
}

function concat(a: Uint8Array, b: Uint8Array): Uint8Array {
  if (a.length === 0) return b;
  if (b.length === 0) return a;
  const out = new Uint8Array(a.length + b.length);
  out.set(a, 0);
  out.set(b, a.length);
  return out;
}
