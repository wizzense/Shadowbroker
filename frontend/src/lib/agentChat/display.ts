/**
 * Model output -> display text. Rendering is ALWAYS React text nodes (never
 * innerHTML), so HTML in a reply is inert; this additionally strips protocol
 * tags, splits out <think> reasoning, removes control characters and caps size.
 */
const MAX_DISPLAY = 20_000;

export function splitThinking(raw: string): { thinking: string; answer: string } {
  let thinking = '';
  let answer = raw.replace(/<think>([\s\S]*?)(<\/think>|$)/g, (_m, t: string) => {
    thinking += t;
    return '';
  });
  answer = answer.replace(/<tool_call>[\s\S]*?(<\/tool_call>|$)/g, '');
  return { thinking: sanitizeText(thinking), answer: sanitizeText(answer) };
}

export function sanitizeText(s: string): string {
  const clean = s.replace(new RegExp('[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F\u202A-\u202E\u2066-\u2069]', 'g'), '');
  return (clean.length > MAX_DISPLAY ? `${clean.slice(0, MAX_DISPLAY)}…` : clean).trim();
}
