/**
 * Best-effort decode of `message.attributedBody`.
 *
 * Modern macOS leaves `message.text` NULL and stores the body in
 * `attributedBody`, a binary typedstream archive of an NSAttributedString. The
 * archive is undocumented and its framing has changed across releases, so this
 * is explicitly a heuristic: locate the `NSString` class entry, read the
 * typedstream length prefix that follows it, and take the bytes as UTF-8.
 *
 * It is version dependent by construction. When no candidate framing yields
 * plausible text the caller gets a marker string and `decoded: false`, never a
 * guess built out of archive noise and never raw bytes.
 */

const NSSTRING_MARKER = Buffer.from('NSString', 'latin1');

/** The typedstream class header that precedes the payload in most releases. */
const CLASS_MARKER = Buffer.from([0x01, 0x94, 0x84, 0x01, 0x2b]);

const LONG_LENGTH_16 = 0x81;
const LONG_LENGTH_32 = 0x82;

/** Shown in place of a body that could not be decoded. Never message content. */
export const UNDECODED_BODY_MARKER = '[message body present but not decodable on this macOS version]';

const OBJECT_REPLACEMENT = '\uFFFC';
const REPLACEMENT_CHARACTER = '\uFFFD';

export interface AttributedBodyDecode {
  text: string;
  /** False when the marker was substituted, so callers can degrade honestly. */
  decoded: boolean;
}

export function decodeAttributedBody(blob: Uint8Array | null | undefined): AttributedBodyDecode {
  if (blob === null || blob === undefined || blob.byteLength === 0) {
    return { text: '', decoded: false };
  }

  // A Uint8Array from node:sqlite may be a view into a larger buffer.
  const bytes = Buffer.from(blob.buffer, blob.byteOffset, blob.byteLength);
  for (const markerEnd of stringClassOffsets(bytes)) {
    const text = readStringPayload(bytes, markerEnd);
    if (text !== null) return { text, decoded: true };
  }
  return { text: UNDECODED_BODY_MARKER, decoded: false };
}

function* stringClassOffsets(bytes: Buffer): Generator<number> {
  let at = bytes.indexOf(NSSTRING_MARKER);
  while (at >= 0) {
    yield at + NSSTRING_MARKER.length;
    at = bytes.indexOf(NSSTRING_MARKER, at + 1);
  }
}

/**
 * Try every framing this file has seen in the wild, nearest-first: with the
 * class marker, then with the padding byte some writers emit, then bare.
 */
function readStringPayload(bytes: Buffer, markerEnd: number): string | null {
  const candidates: number[] = [];
  if (bytes.subarray(markerEnd, markerEnd + CLASS_MARKER.length).equals(CLASS_MARKER)) {
    candidates.push(markerEnd + CLASS_MARKER.length, markerEnd + CLASS_MARKER.length + 1);
  }
  candidates.push(markerEnd, markerEnd + 1, markerEnd + 2);

  for (const start of candidates) {
    const text = decodeAt(bytes, start);
    if (text !== null) return text;
  }
  return null;
}

function decodeAt(bytes: Buffer, start: number): string | null {
  const header = readLength(bytes, start);
  if (header === null || header.length <= 0) return null;
  const end = header.next + header.length;
  if (end > bytes.byteLength) return null;
  const text = bytes.subarray(header.next, end).toString('utf8');
  return isPlausible(text) ? sanitize(text) : null;
}

function readLength(bytes: Buffer, at: number): { length: number; next: number } | null {
  const first = bytes[at];
  if (first === undefined) return null;
  if (first === LONG_LENGTH_16) {
    const lo = bytes[at + 1];
    const hi = bytes[at + 2];
    if (lo === undefined || hi === undefined) return null;
    return { length: lo | (hi << 8), next: at + 3 };
  }
  if (first === LONG_LENGTH_32) {
    const b0 = bytes[at + 1];
    const b1 = bytes[at + 2];
    const b2 = bytes[at + 3];
    const b3 = bytes[at + 4];
    if (b0 === undefined || b1 === undefined || b2 === undefined || b3 === undefined) return null;
    return { length: b0 | (b1 << 8) | (b2 << 16) | (b3 << 24), next: at + 5 };
  }
  if (first < 0x80) return { length: first, next: at + 1 };
  return null;
}

/**
 * Reject archive bytes that happen to look like a length-prefixed string.
 * A real body is text; a mis-framed payload is mostly replacement characters
 * or control bytes.
 */
function isPlausible(text: string): boolean {
  if (text.length === 0) return false;
  let replacements = 0;
  for (const character of text) {
    const code = character.codePointAt(0) ?? 0;
    if (character === REPLACEMENT_CHARACTER) replacements += 1;
    else if (code < 0x20 && character !== '\n' && character !== '\r' && character !== '\t') return false;
  }
  return replacements * 8 <= text.length;
}

function sanitize(text: string): string {
  // U+FFFC marks an attachment inside the attributed string; attachments are
  // reported separately, so leaving the placeholder in the body text would only
  // produce a stray glyph.
  return text.replaceAll(OBJECT_REPLACEMENT, '').replaceAll('\r\n', '\n');
}
