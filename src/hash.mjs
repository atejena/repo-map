/**
 * Shared source hashing.
 *
 * Both the mapper and the freshness check must agree byte for byte on what a
 * file's content hash is, otherwise freshness reports drift that is not there.
 * Keeping one implementation is the only way to guarantee that.
 */

/**
 * Remove comments while preserving string and template literal contents, so
 * that commented-out imports do not pollute the graph but real specifiers
 * inside quotes survive. Newlines are preserved so line numbers stay stable.
 */
export function stripComments(src) {
  let out = '';
  let i = 0;
  const n = src.length;
  let state = 'code'; // code | line | block | single | double | template
  while (i < n) {
    const c = src[i];
    const c2 = src[i + 1];
    if (state === 'code') {
      if (c === '/' && c2 === '/') { state = 'line'; i += 2; continue; }
      if (c === '/' && c2 === '*') { state = 'block'; i += 2; continue; }
      if (c === "'") { state = 'single'; out += c; i++; continue; }
      if (c === '"') { state = 'double'; out += c; i++; continue; }
      if (c === '`') { state = 'template'; out += c; i++; continue; }
      out += c; i++; continue;
    }
    if (state === 'line') {
      if (c === '\n') { state = 'code'; out += c; }
      i++; continue;
    }
    if (state === 'block') {
      if (c === '*' && c2 === '/') { state = 'code'; i += 2; continue; }
      if (c === '\n') out += c;
      i++; continue;
    }
    out += c;
    if (c === '\\') { if (i + 1 < n) out += src[i + 1]; i += 2; continue; }
    if (state === 'single' && c === "'") state = 'code';
    else if (state === 'double' && c === '"') state = 'code';
    else if (state === 'template' && c === '`') state = 'code';
    i++;
  }
  return out;
}

/** Cheap non-cryptographic content hash. Only needs to detect change. */
export function cheapHash(s) {
  let h1 = 0x811c9dc5, h2 = 0x01000193;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    h1 = (h1 ^ c) * 16777619 >>> 0;
    h2 = (h2 + c * (i % 31 + 1)) >>> 0;
  }
  return (h1.toString(16) + h2.toString(16)).padStart(16, '0');
}

/** The hash the snapshot stores for a file's source text. */
export function hashSource(raw) {
  return cheapHash(stripComments(raw));
}
