/** Every character a renderer or a model might treat as a line break. */
const LINE_BREAKS = /\s*[\n\v\f\r\x1c-\x1e\x85\u2028\u2029]+\s*/g;
/** Remaining C0/C1 control characters (tabs are kept). */
const CONTROL = /[\x00-\x08\x0e-\x1b\x1f\x7f-\x84\x86-\x9f]/g;

/**
 * Untrusted text (messages, group names, model output) on one line, so it can't forge
 * transcript lines ("#123 … Me: …"), brief sections, or prompt structure.
 */
export function oneLine(text: string, separator = ' '): string {
  return text.replace(LINE_BREAKS, separator).replace(CONTROL, '');
}

export function clip(text: string, max: number): string {
  return text.length > max ? text.slice(0, max - 1) + '…' : text;
}
