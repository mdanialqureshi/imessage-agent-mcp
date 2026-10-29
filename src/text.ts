/** Runs of every character a renderer or a model might treat as a line break. */
const LINE_BREAKS = /[\n\v\f\r\x1c-\x1e\x85\u2028\u2029]+/;
/** Remaining C0/C1 control characters (tabs are kept). */
const CONTROL = /[\x00-\x08\x0e-\x1b\x1f\x7f-\x84\x86-\x9f]/g;
/**
 * Characters a reader can't see but a model reads: zero-width characters, direction overrides
 * and Unicode tag characters, which can spell out hidden instructions. Emoji keep their joiner
 * (U+200D); the few flags spelled with tags show as a plain black flag.
 */
const INVISIBLE = /[\u200b\u200c\u200e\u200f\u202a-\u202e\u2060-\u2064\u2066-\u2069\ufeff\u{e0000}-\u{e007f}]/gu;

/**
 * Untrusted text (messages, group names, model output) on one line, so it can't forge
 * transcript lines ("#123 … Me: …"), brief sections, or prompt structure.
 */
export function oneLine(text: string, separator = ' '): string {
  // Split and trim rather than one regex with \s* around the breaks: that backtracks
  // quadratically on long runs of spaces, and message text is attacker-controlled.
  const parts = text.split(LINE_BREAKS);
  const last = parts.length - 1;
  const lines = parts
    .map((p, i) => (i > 0 ? p.trimStart() : p))
    .map((p, i) => (i < last ? p.trimEnd() : p))
    .filter((p, i) => p !== '' || i === 0 || i === last); // Blank lines between breaks merge into one.
  return lines.join(separator).replace(CONTROL, '').replace(INVISIBLE, '');
}

export function clip(text: string, max: number): string {
  return text.length > max ? text.slice(0, max - 1) + '…' : text;
}
