// Docs: docs/architecture/mime-parser-implementation.md
//
// RFC 3676 format=flowed reflow. text/plain parts marked `; format=flowed` use trailing spaces as
// soft line breaks (the line continues) and space-stuffing (a leading space is escaping). `delsp=yes`
// means the soft-break space itself is deleted on join. Quote-depth handling is simplified for v1.

export function unflowFormat(text: string, delsp = false): string {
  const lines = text.split(/\r?\n/);
  const out: string[] = [];
  let acc = '';
  let open = false;
  for (const raw of lines) {
    // Space-stuffing: a single leading space is removed (it escapes lines that start with space/>/From).
    const line = raw.startsWith(' ') ? raw.slice(1) : raw;
    const isSig = line === '-- ';
    const flowed = !isSig && line.endsWith(' ');
    acc = open ? acc + line : line;
    if (flowed) {
      if (delsp) acc = acc.slice(0, -1); // the soft-break space is only a marker — drop it
      open = true;
    } else {
      out.push(acc);
      acc = '';
      open = false;
    }
  }
  if (open) out.push(acc);
  return out.join('\n');
}
