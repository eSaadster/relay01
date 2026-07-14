import { describe, expect, it } from "vitest";
import { dslToBlocks, type UiSpec } from "./blocks.js";

describe("dslToBlocks", () => {
  it("renders a title as a plain_text header", () => {
    const blocks = dslToBlocks({ title: "Report" }) as any[];
    expect(blocks).toHaveLength(1);
    expect(blocks[0]).toEqual({ type: "header", text: { type: "plain_text", text: "Report" } });
  });

  it("renders paragraphs as mrkdwn sections", () => {
    const blocks = dslToBlocks({ paragraphs: ["one", "two"] }) as any[];
    expect(blocks).toHaveLength(2);
    expect(blocks[0]).toEqual({ type: "section", text: { type: "mrkdwn", text: "one" } });
    expect(blocks[1].text.text).toBe("two");
  });

  it("aligns table columns by padding to the widest cell", () => {
    const blocks = dslToBlocks({
      table: { headers: ["Name", "Score"], rows: [["Al", 100], ["Madeline", 7]] },
    }) as any[];
    expect(blocks).toHaveLength(1);
    const text: string = blocks[0].text.text;
    expect(text.startsWith("```\n")).toBe(true);
    expect(text.endsWith("\n```")).toBe(true);
    // Strip the fences without trimming so trailing column padding is preserved.
    const lines = text.slice("```\n".length, text.length - "\n```".length).split("\n");
    // "Name" column width is max("Name","Al","Madeline") = 8 → header padded to 8 chars
    expect(lines[0]).toBe("Name      Score");
    expect(lines[1]).toBe("Al        100  ");
    expect(lines[2]).toBe("Madeline  7    ");
  });

  it("scales bars so the largest value fills 20 blocks", () => {
    const blocks = dslToBlocks({
      bars: [
        { label: "big", value: 50 },
        { label: "half", value: 25 },
      ],
    }) as any[];
    expect(blocks).toHaveLength(1);
    const lines: string[] = blocks[0].text.text.replace(/```/g, "").trim().split("\n");
    // largest → 20 full blocks, 0 empty
    expect(lines[0]).toContain("█".repeat(20));
    expect(lines[0]).not.toContain("░");
    // half → 10 full, 10 empty
    expect(lines[1]).toContain("█".repeat(10) + "░".repeat(10));
  });

  it("maps fields to a single section with mrkdwn label/value", () => {
    const blocks = dslToBlocks({
      fields: [{ label: "Status", value: "OK" }],
    }) as any[];
    expect(blocks).toHaveLength(1);
    expect(blocks[0].type).toBe("section");
    expect(blocks[0].fields).toEqual([{ type: "mrkdwn", text: "*Status*\nOK" }]);
  });

  it("truncates fields to 10", () => {
    const fields = Array.from({ length: 15 }, (_, i) => ({ label: `L${i}`, value: `V${i}` }));
    const blocks = dslToBlocks({ fields }) as any[];
    expect(blocks[0].fields).toHaveLength(10);
  });

  it("maps buttons to an actions block with action_id and style", () => {
    const blocks = dslToBlocks({
      buttons: [
        { text: "Go", actionId: "go", style: "primary" },
        { text: "Stop", actionId: "stop" },
      ],
    }) as any[];
    expect(blocks).toHaveLength(1);
    expect(blocks[0].type).toBe("actions");
    expect(blocks[0].elements[0]).toEqual({
      type: "button",
      text: { type: "plain_text", text: "Go" },
      action_id: "go",
      style: "primary",
    });
    expect(blocks[0].elements[1].style).toBeUndefined();
  });

  it("truncates buttons to 25", () => {
    const buttons = Array.from({ length: 30 }, (_, i) => ({ text: `B${i}`, actionId: `b${i}` }));
    const blocks = dslToBlocks({ buttons }) as any[];
    expect(blocks[0].elements).toHaveLength(25);
  });

  it("produces no blocks for an empty spec and skips empty optional sections", () => {
    expect(dslToBlocks({})).toEqual([]);
    expect(dslToBlocks({ paragraphs: [], fields: [], bars: [], buttons: [] })).toEqual([]);
  });

  it("renders a full spec in title/paragraph/table/fields/bars/buttons order", () => {
    const spec: UiSpec = {
      title: "T",
      paragraphs: ["p"],
      table: { headers: ["a"], rows: [["b"]] },
      fields: [{ label: "f", value: "v" }],
      bars: [{ label: "x", value: 1 }],
      buttons: [{ text: "btn", actionId: "id" }],
    };
    const blocks = dslToBlocks(spec) as any[];
    expect(blocks.map((b) => b.type)).toEqual([
      "header",
      "section",
      "section",
      "section",
      "section",
      "actions",
    ]);
  });
});
