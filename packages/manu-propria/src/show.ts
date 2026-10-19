/** The longest line Connect shows and binds into the signature (UTF-16 code units, after normalizing). */
export const SHOW_MAX_LENGTH = 500;

/**
 * The line exactly as Connect binds it: NFC, runs of whitespace as one space, no leading or trailing space.
 * Returns null when nothing is left or the line is longer than Connect shows.
 *
 * The same normalized line goes into the call document and into the request, so the line in the receipt
 * can be compared with the call byte for byte.
 */
export function normalizeShow(line: unknown): string | null {
  if (typeof line !== "string") return null;
  const s = line.normalize("NFC").replace(/\s+/g, " ").trim();
  if (s.length === 0 || s.length > SHOW_MAX_LENGTH) return null;
  return s;
}
