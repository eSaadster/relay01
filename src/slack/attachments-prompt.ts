// File-aware prompt hints: the type of an uploaded file shapes what the agent
// is nudged to do with it (OpenTag-style, e.g. CSV upload → offer a chart).

import type { Attachment } from "./store.js";

type FileKind = "tabular" | "image" | "document" | "audio" | "archive" | "other";

const KIND_BY_EXT: Record<string, FileKind> = {
  csv: "tabular",
  tsv: "tabular",
  xlsx: "tabular",
  xls: "tabular",
  png: "image",
  jpg: "image",
  jpeg: "image",
  gif: "image",
  webp: "image",
  pdf: "document",
  doc: "document",
  docx: "document",
  txt: "document",
  md: "document",
  mp3: "audio",
  wav: "audio",
  m4a: "audio",
  ogg: "audio",
  zip: "archive",
  gz: "archive",
  tar: "archive",
};

const KIND_HINTS: Record<FileKind, string> = {
  tabular:
    "Tabular data: read it and summarize what it contains. If it has numeric series, render a chart with render_chart (or a table with render_ui) rather than describing the numbers in prose.",
  image: "Image: look at it before answering.",
  document: "Document: read/extract its content before answering.",
  audio: "Audio: transcribe it before answering if a transcription skill is available.",
  archive: "Archive: list its contents (e.g. unzip -l) before deciding what to do.",
  other: "",
};

function kindOf(filename: string): FileKind {
  const ext = filename.split(".").pop()?.toLowerCase() ?? "";
  return KIND_BY_EXT[ext] ?? "other";
}

/**
 * Format the attachment listing appended to the agent prompt, with a
 * type-specific hint per distinct file kind. Returns "" for no attachments.
 */
export function formatAttachmentsPrompt(attachments: Attachment[]): string {
  if (attachments.length === 0) return "";
  const lines = attachments.map((a) => `- ${a.original} → ${a.local}`);
  const hints = [...new Set(attachments.map((a) => KIND_HINTS[kindOf(a.original)]))].filter(Boolean);
  const hintBlock = hints.length ? `\n${hints.map((h) => `Note: ${h}`).join("\n")}` : "";
  return `\n\n[Attachments downloaded to scratchpad/attachments/]\n${lines.join("\n")}${hintBlock}`;
}
