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

  it("renders context as a single context block with mrkdwn elements", () => {
    const blocks = dslToBlocks({ context: ["🟢 Healthy", "Updated today"] }) as any[];
    expect(blocks).toHaveLength(1);
    expect(blocks[0].type).toBe("context");
    expect(blocks[0].elements).toEqual([
      { type: "mrkdwn", text: "🟢 Healthy" },
      { type: "mrkdwn", text: "Updated today" },
    ]);
  });

  it("truncates context to 10 elements", () => {
    const context = Array.from({ length: 14 }, (_, i) => `c${i}`);
    const blocks = dslToBlocks({ context }) as any[];
    expect(blocks[0].elements).toHaveLength(10);
  });

  it("renders a card with linked title, Open button, status line, and fields", () => {
    const blocks = dslToBlocks({
      cards: [
        {
          title: "Fix login bug",
          url: "https://linear.app/issue/1",
          status: "🟡 In Progress",
          badges: ["@ali", "High"],
          body: "Session cookie expires early.",
          fields: [{ label: "Team", value: "Auth" }],
        },
      ],
    }) as any[];
    expect(blocks.map((b: any) => b.type)).toEqual(["section", "context", "section"]);
    expect(blocks[0].text.text).toBe("*<https://linear.app/issue/1|Fix login bug>*\nSession cookie expires early.");
    expect(blocks[0].accessory).toMatchObject({ type: "button", url: "https://linear.app/issue/1" });
    expect(blocks[1].elements.map((e: any) => e.text)).toEqual(["🟡 In Progress", "@ali", "High"]);
    expect(blocks[2].fields).toEqual([{ type: "mrkdwn", text: "*Team*\nAuth" }]);
  });

  it("renders a minimal card without url as a bold title only and separates cards with dividers", () => {
    const blocks = dslToBlocks({ cards: [{ title: "A" }, { title: "B" }] }) as any[];
    expect(blocks.map((b: any) => b.type)).toEqual(["section", "divider", "section"]);
    expect(blocks[0].text.text).toBe("*A*");
    expect(blocks[0].accessory).toBeUndefined();
  });

  it("gives card Open buttons unique action_ids across cards", () => {
    const blocks = dslToBlocks({
      cards: [
        { title: "A", url: "https://x.test/a" },
        { title: "B", url: "https://x.test/a" },
      ],
    }) as any[];
    const ids = blocks.filter((b: any) => b.accessory).map((b: any) => b.accessory.action_id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("renders a link button with a url", () => {
    const blocks = dslToBlocks({ buttons: [{ text: "Open", actionId: "open", url: "https://x.test" }] }) as any[];
    expect(blocks[0].elements[0].url).toBe("https://x.test");
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
