// DSL → Block Kit compiler.
// Turns a compact UiSpec into an array of Slack Block Kit blocks.

export interface UiCard {
  title: string;
  url?: string;
  status?: string;
  badges?: string[];
  body?: string;
  fields?: { label: string; value: string }[];
}

export interface UiSpec {
  title?: string;
  paragraphs?: string[];
  context?: string[];
  table?: { headers: string[]; rows: (string | number)[][] };
  fields?: { label: string; value: string }[];
  bars?: { label: string; value: number }[];
  cards?: UiCard[];
  buttons?: { text: string; actionId: string; url?: string; style?: "primary" | "danger" }[];
}

// Slack Block Kit constraints (exceeding any of these makes the whole
// chat.update/postMessage fail with `invalid_blocks`, so we defensively clamp):
// - a `section`/`mrkdwn` text field is at most 3000 chars
// - a `header` plain_text is at most 150 chars
// - a button `text` is at most 75 chars and every `action_id` must be
//   non-empty and unique within the message
// - a `section` with `fields` allows at most 10 fields
// - a `context` block allows at most 10 elements
// - an `actions` block at most 25 elements
// - a message has at most 50 blocks
// - a button `url` is at most 3000 chars
const MAX_SECTION_TEXT = 3000;
const MAX_HEADER_TEXT = 150;
const MAX_BUTTON_TEXT = 75;
const MAX_FIELDS = 10;
const MAX_CONTEXT_ELEMENTS = 10;
const MAX_BUTTONS = 25;
const MAX_BLOCKS = 50;
const MAX_URL = 3000;
// Native table block limits: 100 rows (incl. header), 20 cells per row.
const MAX_TABLE_ROWS = 100;
const MAX_TABLE_COLS = 20;

// Length of the surrounding "```\n" … "\n```" code fence.
const FENCE_OVERHEAD = "```\n\n```".length;

/** Clamp a plain section text to the section limit, appending a marker when cut. */
function capSection(text: string): string {
  if (text.length <= MAX_SECTION_TEXT) return text;
  return text.slice(0, MAX_SECTION_TEXT - 1) + "…";
}

/** Clamp the inner body of a fenced code block so the fenced result fits the section limit. */
function fenced(body: string): string {
  const budget = MAX_SECTION_TEXT - FENCE_OVERHEAD;
  const inner = body.length <= budget ? body : body.slice(0, budget - 1) + "…";
  return "```\n" + inner + "\n```";
}

/** Build a context block from small mrkdwn snippets (status line, badges). */
function contextBlock(elements: string[]): unknown {
  return {
    type: "context",
    elements: elements.slice(0, MAX_CONTEXT_ELEMENTS).map((t) => ({ type: "mrkdwn", text: capSection(t) })),
  };
}

/** Render one card (issue/page/incident style) into blocks. */
function cardToBlocks(card: UiCard, idx: number): any[] {
  const out: any[] = [];
  const url = card.url && card.url.length <= MAX_URL ? card.url : undefined;
  const titleMd = url ? `*<${url}|${card.title}>*` : `*${card.title}*`;
  const text = capSection(card.body ? `${titleMd}\n${card.body}` : titleMd);
  const section: any = { type: "section", text: { type: "mrkdwn", text } };
  if (url) {
    section.accessory = {
      type: "button",
      text: { type: "plain_text", text: "Open" },
      url,
      action_id: `card_open_${idx}`,
    };
  }
  out.push(section);
  const meta = [...(card.status ? [card.status] : []), ...(card.badges ?? [])];
  if (meta.length) out.push(contextBlock(meta));
  if (card.fields?.length) {
    out.push({
      type: "section",
      fields: card.fields.slice(0, MAX_FIELDS).map((f) => ({ type: "mrkdwn", text: "*" + f.label + "*\n" + f.value })),
    });
  }
  return out;
}

export function dslToBlocks(ui: UiSpec): unknown[] {
  const b: any[] = [];
  if (ui.title) b.push({ type: "header", text: { type: "plain_text", text: ui.title.slice(0, MAX_HEADER_TEXT) } });
  if (ui.context?.length) b.push(contextBlock(ui.context));
  for (const p of ui.paragraphs ?? []) b.push({ type: "section", text: { type: "mrkdwn", text: capSection(p) } });
  ui.cards?.forEach((card, i) => {
    if (i > 0) b.push({ type: "divider" });
    b.push(...cardToBlocks(card, i));
  });
  if (ui.table) {
    // Native table block: bold header row, numeric columns right-aligned.
    const headers = ui.table.headers.slice(0, MAX_TABLE_COLS);
    const headerRow = headers.map((h) => ({
      type: "rich_text",
      elements: [{ type: "rich_text_section", elements: [{ type: "text", text: String(h), style: { bold: true } }] }],
    }));
    const dataRows = ui.table.rows
      .slice(0, MAX_TABLE_ROWS - 1)
      .map((r) => r.slice(0, MAX_TABLE_COLS).map((c) => ({ type: "raw_text", text: String(c ?? "") })));
    const column_settings = headers.map((_, ci) => ({
      align: ui.table!.rows.length > 0 && ui.table!.rows.every((r) => typeof r[ci] === "number") ? "right" : "left",
    }));
    b.push({ type: "table", rows: [headerRow, ...dataRows], column_settings });
  }
  if (ui.fields?.length) {
    b.push({
      type: "section",
      fields: ui.fields.slice(0, MAX_FIELDS).map((f) => ({ type: "mrkdwn", text: "*" + f.label + "*\n" + f.value })),
    });
  }
  if (ui.bars?.length) {
    const max = Math.max(...ui.bars.map((x) => x.value)) || 1;
    const lines = ui.bars.map((x) => {
      const n = Math.round((x.value / max) * 20);
      return x.label.padEnd(12) + " " + "█".repeat(n) + "░".repeat(20 - n) + " " + x.value;
    });
    b.push({ type: "section", text: { type: "mrkdwn", text: fenced(lines.join("\n")) } });
  }
  if (ui.buttons?.length) {
    const seen = new Set<string>();
    const elements = ui.buttons.slice(0, MAX_BUTTONS).map((x, i) => {
      // action_id must be non-empty and unique within the message.
      let actionId = x.actionId && x.actionId.length > 0 ? x.actionId : `action_${i}`;
      if (seen.has(actionId)) actionId = `${actionId}_${i}`;
      seen.add(actionId);
      return {
        type: "button",
        text: { type: "plain_text", text: x.text.slice(0, MAX_BUTTON_TEXT) },
        action_id: actionId,
        ...(x.url && x.url.length <= MAX_URL ? { url: x.url } : {}),
        style: x.style,
      };
    });
    b.push({ type: "actions", elements });
  }
  return b.slice(0, MAX_BLOCKS);
}
