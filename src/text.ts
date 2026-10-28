/** Runs of every character a renderer or a model might treat as a line break. */
const LINE_BREAKS = /[\n\v\f\r\x1c-\x1e\x85\u2028\u2029]+/;
/** Remaining C0/C1 control characters (tabs are kept). */
const CONTROL = /[\x00-\x08\x0e-\x1b\x1f\x7f-\x84\x86-\x9f]/g;

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
  return lines.join(separator).replace(CONTROL, '');
}

export function clip(text: string, max: number): string {
  return text.length > max ? text.slice(0, max - 1) + '…' : text;
}
