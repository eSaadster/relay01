import { describe, expect, it } from "vitest";
import { formatAttachmentsPrompt } from "./attachments-prompt.js";

describe("formatAttachmentsPrompt", () => {
  it("returns empty string for no attachments", () => {
    expect(formatAttachmentsPrompt([])).toBe("");
  });

  it("lists files with their local paths", () => {
    const out = formatAttachmentsPrompt([{ original: "notes.xyz", local: "attachments/1_notes.xyz" }]);
    expect(out).toContain("- notes.xyz → attachments/1_notes.xyz");
    expect(out).toContain("[Attachments downloaded to scratchpad/attachments/]");
    expect(out).not.toContain("Note:"); // unknown type gets no hint
  });

  it("adds a chart hint for tabular files", () => {
    const out = formatAttachmentsPrompt([{ original: "Q3 Revenue.CSV", local: "attachments/q3.csv" }]);
    expect(out).toContain("render_chart");
  });

  it("dedupes hints for multiple files of the same kind and combines distinct kinds", () => {
    const out = formatAttachmentsPrompt([
      { original: "a.csv", local: "x/a.csv" },
      { original: "b.xlsx", local: "x/b.xlsx" },
      { original: "shot.png", local: "x/shot.png" },
    ]);
    expect(out.match(/render_chart/g)).toHaveLength(1);
    expect(out).toContain("Image: look at it");
  });
});
