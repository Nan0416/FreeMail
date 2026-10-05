/**
 * Avatar initials: the first letters of the first two words, or one letter for a single
 * word. Taken from the display name, or else the address's local part.
 */
export function initials(name: string | undefined, address: string): string {
  const source = name?.trim() || address.split('@')[0] || '?';
  const words = source.split(/[\s._-]+/).filter((w) => w.length > 0);
  const letters =
    words.length >= 2 ? `${words[0][0]}${words[1][0]}` : (words[0] ?? '?').slice(0, 1);
  return letters.toUpperCase();
}

/**
 * Muted avatar tints. Picked by hashing the address, so a correspondent keeps one colour
 * everywhere without any of it being stored.
 */
const AVATAR_TINTS = [
  'bg-sky-100 text-sky-800',
  'bg-violet-100 text-violet-800',
  'bg-emerald-100 text-emerald-800',
  'bg-amber-100 text-amber-800',
  'bg-rose-100 text-rose-800',
  'bg-teal-100 text-teal-800',
  'bg-indigo-100 text-indigo-800',
  'bg-stone-200 text-stone-800',
];

export function avatarTint(address: string): string {
  let hash = 0;
  for (const ch of address.toLowerCase()) {
    hash = (hash * 31 + ch.charCodeAt(0)) | 0;
  }
  return AVATAR_TINTS[Math.abs(hash) % AVATAR_TINTS.length];
}

/** The friendly part of an address list entry: the local part, for compact list rows. */
export function shortAddress(address: string): string {
  return address.split('@')[0] || address;
}

/** Split a comma/semicolon/newline-separated recipient string into trimmed addresses. */
export function parseRecipients(value: string): string[] {
  return value
    .split(/[,;\n]/)
    .map((part) => part.trim())
    .filter((part) => part.length > 0);
}
