import { describe, expect, it } from "vitest";
import { SLACK_MAX_TEXT, splitSlackText } from "./split-message.js";

describe("splitSlackText", () => {
  it("returns a single chunk when under the limit", () => {
    expect(splitSlackText("hello")).toEqual(["hello"]);
  });

  it("returns a single chunk at exactly the limit", () => {
    const text = "a".repeat(SLACK_MAX_TEXT);
    expect(splitSlackText(text)).toEqual([text]);
  });

  it("splits on paragraph boundaries when possible", () => {
    const para1 = "a".repeat(2500);
    const para2 = "b".repeat(2500);
    const text = `${para1}\n\n${para2}`;
    const chunks = splitSlackText(text);
    expect(chunks).toHaveLength(2);
    expect(chunks[0]).toBe(`${para1}\n\n`);
    expect(chunks[1]).toBe(para2);
    for (const chunk of chunks) {
      expect(chunk.length).toBeLessThanOrEqual(SLACK_MAX_TEXT);
    }
  });

  it("splits on line boundaries when paragraphs are too far apart", () => {
    const line1 = "a".repeat(3000);
    const line2 = "b".repeat(1500);
    const text = `${line1}\n${line2}`;
    const chunks = splitSlackText(text);
    expect(chunks).toHaveLength(2);
    expect(chunks.join("")).toBe(text);
    for (const chunk of chunks) {
      expect(chunk.length).toBeLessThanOrEqual(SLACK_MAX_TEXT);
    }
  });

  it("hard-splits when no good boundary exists", () => {
    const text = "x".repeat(SLACK_MAX_TEXT + 500);
    const chunks = splitSlackText(text);
    expect(chunks).toHaveLength(2);
    expect(chunks[0].length).toBe(SLACK_MAX_TEXT);
    expect(chunks[1].length).toBe(500);
  });
});
