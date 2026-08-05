/** Slack `text` field limit for chat.postMessage / chat.update. */
export const SLACK_MAX_TEXT = 4000;

/**
 * Split text into chunks that fit Slack's message text limit.
 * Prefers paragraph, line, then word boundaries before hard-cutting.
 */
export function splitSlackText(text: string, maxLen = SLACK_MAX_TEXT): string[] {
  if (text.length <= maxLen) return [text];

  const chunks: string[] = [];
  let remaining = text;

  while (remaining.length > 0) {
    if (remaining.length <= maxLen) {
      chunks.push(remaining);
      break;
    }

    const window = remaining.slice(0, maxLen);
    let splitAt = maxLen;

    const para = window.lastIndexOf("\n\n");
    if (para > maxLen * 0.5) {
      splitAt = para + 2;
    } else {
      const line = window.lastIndexOf("\n");
      if (line > maxLen * 0.5) {
        splitAt = line + 1;
      } else {
        const space = window.lastIndexOf(" ");
        if (space > maxLen * 0.5) splitAt = space + 1;
      }
    }

    chunks.push(remaining.slice(0, splitAt));
    remaining = remaining.slice(splitAt);
  }

  return chunks;
}
