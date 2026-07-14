import { describe, expect, it } from "vitest";

import { applyFeedbackToScratchpad } from "./feedback.js";
import type { Scratchpad } from "./pi-agent-scratchpad.js";

function emptyScratchpad(): Scratchpad {
	return { summary: [], critical: [], recentTurns: [] };
}

describe("applyFeedbackToScratchpad", () => {
	it("builds a positive note", () => {
		const result = applyFeedbackToScratchpad(emptyScratchpad(), true, "great answer");
		expect(result.critical[0]).toBe('👍 User approved this kind of response: "great answer"');
	});

	it("builds a negative note", () => {
		const result = applyFeedbackToScratchpad(emptyScratchpad(), false, "bad answer");
		expect(result.critical[0]).toBe('👎 User disliked this response — avoid repeating: "bad answer"');
	});

	it("preserves other scratchpad fields", () => {
		const sp: Scratchpad = {
			summary: ["a summary"],
			critical: [],
			recentTurns: [{ role: "user", content: "hi" }],
		};
		const result = applyFeedbackToScratchpad(sp, true, "x");
		expect(result.summary).toEqual(["a summary"]);
		expect(result.recentTurns).toEqual([{ role: "user", content: "hi" }]);
	});

	it("dedupes identical notes and moves the note to the front", () => {
		const sp = emptyScratchpad();
		const once = applyFeedbackToScratchpad(sp, true, "same");
		const note = once.critical[0];
		// Add another critical so the existing note is not at the front
		once.critical.push("other note");
		const twice = applyFeedbackToScratchpad(once, true, "same");
		expect(twice.critical.filter((c) => c === note)).toHaveLength(1);
		expect(twice.critical[0]).toBe(note);
		expect(twice.critical).toContain("other note");
	});

	it("caps the critical list at 20, keeping newest first", () => {
		const sp: Scratchpad = {
			summary: [],
			critical: Array.from({ length: 20 }, (_, i) => `old-${i}`),
			recentTurns: [],
		};
		const result = applyFeedbackToScratchpad(sp, true, "newest");
		expect(result.critical).toHaveLength(20);
		expect(result.critical[0]).toBe('👍 User approved this kind of response: "newest"');
		// Oldest item (old-19) should have been dropped
		expect(result.critical).not.toContain("old-19");
		expect(result.critical[1]).toBe("old-0");
	});

	it("truncates snippet to 160 chars and collapses whitespace", () => {
		const longText = "  line one\n\tline   two   " + "x".repeat(200);
		const result = applyFeedbackToScratchpad(emptyScratchpad(), true, longText);
		const match = result.critical[0].match(/"(.*)"$/);
		const snippet = match![1];
		expect(snippet.length).toBeLessThanOrEqual(160);
		expect(snippet).not.toContain("\n");
		expect(snippet).not.toContain("\t");
		expect(snippet.startsWith("line one line two")).toBe(true);
	});
});
