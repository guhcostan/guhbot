/**
 * Recognising the identifiers that appear in an allow list.
 *
 * A Messages chat GUID is `<service>;<kind>;<identifier>`: kind `-` is a one to
 * one conversation and its identifier is the other party's handle; kind `+` is
 * a group and its identifier is an opaque `chat…` token. Only the first form
 * carries a handle, which matters because allowing a handle should allow the
 * conversation with that person — never a group they happen to be in.
 */

const CHAT_GUID = /^([A-Za-z0-9._-]+);([+-]);(.+)$/;
const PHONE_LIKE = /^\+?[0-9][0-9\s().-]{3,}$/;

export function isChatGuid(value: string): boolean {
  return CHAT_GUID.test(value.trim());
}

export function isDirectChatGuid(value: string): boolean {
  const match = CHAT_GUID.exec(value.trim());
  return match?.[2] === '-';
}

/** The handle inside a one to one chat GUID, or null for a group or a handle. */
export function chatGuidHandle(value: string): string | null {
  const match = CHAT_GUID.exec(value.trim());
  if (match?.[2] !== '-') return null;
  return match[3] ?? null;
}

export function isPhoneLike(value: string): boolean {
  return PHONE_LIKE.test(value.trim());
}

/**
 * Fold an entry to a comparison key.
 *
 * Phone numbers arrive formatted however the user typed them, so they compare
 * on digits alone (a leading `+` kept, since it distinguishes a country code
 * from a local number). Everything else compares case-insensitively: email
 * handles are case-insensitive in practice and chat GUIDs are ASCII.
 */
export function normalizeIdentifier(value: string): string {
  const trimmed = value.trim();
  if (isPhoneLike(trimmed)) {
    const digits = trimmed.replace(/[^0-9]/g, '');
    return trimmed.startsWith('+') ? `+${digits}` : digits;
  }
  return trimmed.toLowerCase();
}
