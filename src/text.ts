/** Runs of every character a renderer or a model might treat as a line break. */
const LINE_BREAKS = /[\n\v\f\r\x1c-\x1e\x85\u2028\u2029]+/;
/** Remaining C0/C1 control characters (tabs are kept). */
const CONTROL = /[\x00-\x08\x0e-\x1b\x1f\x7f-\x84\x86-\x9f]/g;
/**
 * Characters a reader can't see but a model reads, by Unicode's own definition: everything
 * "default ignorable" or a format character (zero-width characters, direction controls, tag
 * characters, variation selectors, which can spell out hidden instructions), plus the blank
 * fillers that render as nothing (Braille, Hangul).
 */
const INVISIBLE = /(?![\u200d\ufe0f])[\p{Default_Ignorable_Code_Point}\p{Cf}\u2800\u3164\uffa0]/gu;
/** Emoji keep a joiner (U+200D) only between two emoji... */
const STRAY_JOINER = /(?<![\p{Extended_Pictographic}\p{Emoji_Modifier}\ufe0f])\u200d|\u200d(?!\p{Extended_Pictographic})/gu;
/** ...and one emoji presentation selector (U+FE0F) right after an emoji or keycap. */
const STRAY_SELECTOR = /(?<![\p{Extended_Pictographic}0-9#*])\ufe0f/gu;

/**
 * Text without the control and invisible characters that could hide something from a reader.
 * Flags spelled with tags show as a plain black flag.
 */
export const visible = (text: string) =>
  text.replace(CONTROL, '').replace(INVISIBLE, '').replace(STRAY_SELECTOR, '').replace(STRAY_JOINER, '');

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
  return visible(lines.join(separator));
}

export function clip(text: string, max: number): string {
  return text.length > max ? text.slice(0, max - 1) + '…' : text;
}
