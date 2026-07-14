import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

const tmpHome = await fs.mkdtemp(path.join(os.tmpdir(), "relay01-memory-test-"));

vi.mock("node:os", async (importOriginal) => {
	const actual = await importOriginal<typeof import("node:os")>();
	return { ...actual, default: { ...actual, homedir: () => tmpHome }, homedir: () => tmpHome };
});

const {
	consolidateGlobalMemory,
	consolidateUserMemory,
	ensureGlobalMemoryFile,
	formatGlobalMemoryBlock,
	formatUserMemoryBlock,
	loadGlobalMemory,
	loadUserMemory,
	maybeConsolidateGlobalMemory,
	maybeConsolidateUserMemory,
	MEMORY_BASE,
	proposeGlobalFacts,
	proposeUserFacts,
	readPendingFacts,
	readPendingUserFacts,
	recordUserIdentity,
} = await import("./memory-store.js");
const { parseSummarizerResponse } = await import("./pi-agent-summarizer.js");

const globalMemoryPath = path.join(MEMORY_BASE, "global", "MEMORY.md");

describe("memory-store (global scope)", () => {
	beforeEach(async () => {
		await fs.rm(MEMORY_BASE, { recursive: true, force: true });
	});

	afterAll(async () => {
		await fs.rm(tmpHome, { recursive: true, force: true });
	});

	it("uses a base path outside the slack sandbox tree", () => {
		expect(MEMORY_BASE).toBe(path.join(tmpHome, "relay01", "memory"));
		expect(MEMORY_BASE.startsWith(path.join(tmpHome, "relay01", "slack"))).toBe(false);
	});

	it("returns null when no memory file exists", async () => {
		expect(await loadGlobalMemory()).toBeNull();
	});

	it("seeds a template on first ensure and does not overwrite edits", async () => {
		await ensureGlobalMemoryFile();
		const seeded = await fs.readFile(globalMemoryPath, "utf-8");
		expect(seeded).toContain("# Global memory");

		await fs.writeFile(globalMemoryPath, "- Demo day is Friday.\n");
		await ensureGlobalMemoryFile();
		expect(await fs.readFile(globalMemoryPath, "utf-8")).toBe("- Demo day is Friday.\n");
	});

	it("treats the untouched seed template as empty", async () => {
		await ensureGlobalMemoryFile();
		expect(await loadGlobalMemory()).toBeNull();
	});

	it("loads trimmed content once edited", async () => {
		await ensureGlobalMemoryFile();
		await fs.writeFile(globalMemoryPath, "\n- Demo day is Friday.\n\n");
		expect(await loadGlobalMemory()).toBe("- Demo day is Friday.");
	});

	it("returns null for an empty file", async () => {
		await fs.mkdir(path.dirname(globalMemoryPath), { recursive: true });
		await fs.writeFile(globalMemoryPath, "  \n");
		expect(await loadGlobalMemory()).toBeNull();
	});

	it("truncates oversized content with a note", async () => {
		await fs.mkdir(path.dirname(globalMemoryPath), { recursive: true });
		await fs.writeFile(globalMemoryPath, "x".repeat(10000));
		const loaded = await loadGlobalMemory();
		expect(loaded).not.toBeNull();
		expect(loaded!.length).toBeLessThan(10000);
		expect(loaded).toContain("[memory truncated");
	});

	it("formats a labeled prompt block", () => {
		const block = formatGlobalMemoryBlock("- fact one");
		expect(block).toBe("## Shared memory (global — applies across all sessions)\n- fact one\n");
	});
});

function fact(text: string, sourceSession = "@saad") {
	return { text, sourceSession, timestamp: "2026-07-14T00:00:00.000Z" };
}

describe("memory-store harvest path", () => {
	beforeEach(async () => {
		await fs.rm(MEMORY_BASE, { recursive: true, force: true });
	});

	it("appends proposed facts to the pending inbox", async () => {
		await proposeGlobalFacts([fact("demo day is Friday")]);
		await proposeGlobalFacts([fact("staging moved", "#eng"), fact("  ")]);
		const pending = await readPendingFacts();
		expect(pending.map((f) => f.text)).toEqual(["demo day is Friday", "staging moved"]);
		expect(pending[1].sourceSession).toBe("#eng");
	});

	it("skips malformed inbox lines", async () => {
		await proposeGlobalFacts([fact("real fact")]);
		await fs.appendFile(path.join(MEMORY_BASE, "global", "pending.jsonl"), "not json\n");
		const pending = await readPendingFacts();
		expect(pending.map((f) => f.text)).toEqual(["real fact"]);
	});

	it("consolidates pending facts into MEMORY.md and archives the inbox", async () => {
		await proposeGlobalFacts([fact("demo day is Friday"), fact("staging moved", "#eng")]);
		let seenPrompt = "";
		await consolidateGlobalMemory(async (prompt) => {
			seenPrompt = prompt;
			return "- Demo day is Friday.\n- Staging is at staging2.internal.";
		});

		expect(seenPrompt).toContain("demo day is Friday");
		expect(seenPrompt).toContain("[#eng @ 2026-07-14T00:00:00.000Z]");
		expect(await loadGlobalMemory()).toContain("- Demo day is Friday.");
		expect(await readPendingFacts()).toEqual([]);
		const archive = await fs.readFile(
			path.join(MEMORY_BASE, "global", "pending.archive.jsonl"),
			"utf-8",
		);
		expect(archive).toContain("demo day is Friday");
	});

	it("keeps memory and inbox untouched when the LLM returns no bullets", async () => {
		await fs.mkdir(path.join(MEMORY_BASE, "global"), { recursive: true });
		await fs.writeFile(path.join(MEMORY_BASE, "global", "MEMORY.md"), "- existing fact\n");
		await proposeGlobalFacts([fact("new fact")]);

		await consolidateGlobalMemory(async () => "I couldn't process that.");

		expect(await loadGlobalMemory()).toBe("- existing fact");
		expect((await readPendingFacts()).map((f) => f.text)).toEqual(["new fact"]);
	});

	it("does nothing when the inbox is empty", async () => {
		let called = false;
		await consolidateGlobalMemory(async () => {
			called = true;
			return "- x";
		});
		expect(called).toBe(false);
	});

	it("maybeConsolidate defers below the threshold and runs at it", async () => {
		let calls = 0;
		const llm = async () => {
			calls++;
			return "- merged fact";
		};

		await proposeGlobalFacts([fact("one"), fact("two")]);
		await maybeConsolidateGlobalMemory(llm);
		expect(calls).toBe(0);

		await proposeGlobalFacts(
			Array.from({ length: 8 }, (_, i) => fact(`fact ${i + 3}`)),
		);
		await maybeConsolidateGlobalMemory(llm);
		expect(calls).toBe(1);
		expect(await loadGlobalMemory()).toContain("- merged fact");
	});
});

describe("memory-store user scope", () => {
	beforeEach(async () => {
		await fs.rm(MEMORY_BASE, { recursive: true, force: true });
	});

	it("keeps user facts separate per user ID and from global", async () => {
		await proposeUserFacts("U111", [fact("likes TypeScript")]);
		await proposeUserFacts("U222", [fact("likes Python")]);
		await proposeGlobalFacts([fact("demo day is Friday")]);

		expect((await readPendingUserFacts("U111")).map((f) => f.text)).toEqual(["likes TypeScript"]);
		expect((await readPendingUserFacts("U222")).map((f) => f.text)).toEqual(["likes Python"]);
		expect((await readPendingFacts()).map((f) => f.text)).toEqual(["demo day is Friday"]);
	});

	it("rejects path-traversal user IDs", async () => {
		await expect(proposeUserFacts("../global", [fact("evil")])).rejects.toThrow(/Invalid user ID/);
	});

	it("consolidates into users/{id}/MEMORY.md and loads it back", async () => {
		await proposeUserFacts("U111", [fact("works on infra"), fact("prefers TS")]);
		await consolidateUserMemory("U111", async () => "- Works on infra.\n- Prefers TypeScript.");

		expect(await loadUserMemory("U111")).toContain("- Prefers TypeScript.");
		expect(await loadUserMemory("U222")).toBeNull();
		expect(await readPendingUserFacts("U111")).toEqual([]);
		const memFile = await fs.readFile(
			path.join(MEMORY_BASE, "users", "U111", "MEMORY.md"),
			"utf-8",
		);
		expect(memFile).toContain("# Memory for U111");
	});

	it("maybeConsolidate uses the lower user threshold (5)", async () => {
		let calls = 0;
		const llm = async () => {
			calls++;
			return "- merged";
		};
		await proposeUserFacts("U111", Array.from({ length: 4 }, (_, i) => fact(`f${i}`)));
		await maybeConsolidateUserMemory("U111", llm);
		expect(calls).toBe(0);

		await proposeUserFacts("U111", [fact("f5")]);
		await maybeConsolidateUserMemory("U111", llm);
		expect(calls).toBe(1);
	});

	it("records identities without duplicating usernames", async () => {
		await recordUserIdentity("U111", "saad");
		await recordUserIdentity("U111", "saad");
		await recordUserIdentity("U111", "saad2");
		const identity = JSON.parse(
			await fs.readFile(path.join(MEMORY_BASE, "users", "U111", "identity.json"), "utf-8"),
		);
		expect(identity).toEqual({ userId: "U111", userNames: ["saad", "saad2"] });
	});

	it("formats the user prompt block", () => {
		expect(formatUserMemoryBlock("saad", "- likes TS")).toBe(
			"## About @saad (remembered across sessions)\n- likes TS\n",
		);
	});
});

describe("parseSummarizerResponse promote section", () => {
	it("extracts promote bullets alongside summary and critical", () => {
		const response = [
			"## summary",
			"- talked about deploys",
			"",
			"## critical",
			"- user prefers TypeScript",
			"",
			"## promote",
			"- Staging URL moved to staging2.internal",
			"- Demo day is Friday",
		].join("\n");
		const parsed = parseSummarizerResponse(response);
		expect(parsed.summary).toEqual(["talked about deploys"]);
		expect(parsed.critical).toEqual(["user prefers TypeScript"]);
		expect(parsed.promote).toEqual([
			"Staging URL moved to staging2.internal",
			"Demo day is Friday",
		]);
	});

	it("returns empty promote when the section is missing or empty", () => {
		expect(parseSummarizerResponse("## summary\n- a\n\n## critical\n- b").promote).toEqual([]);
		expect(parseSummarizerResponse("## promote\n\n## summary\n- a").promote).toEqual([]);
	});

	it("extracts promote-user separately from promote", () => {
		const parsed = parseSummarizerResponse(
			"## promote\n- team fact\n\n## promote-user\n- is a designer\n- prefers dark mode",
		);
		expect(parsed.promote).toEqual(["team fact"]);
		expect(parsed.promoteUser).toEqual(["is a designer", "prefers dark mode"]);
	});
});
