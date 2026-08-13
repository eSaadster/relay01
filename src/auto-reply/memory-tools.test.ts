import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import {
  afterAll,
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";

const tmpHome = await fs.mkdtemp(
  path.join(os.tmpdir(), "relay01-memtools-test-"),
);

vi.mock("node:os", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:os")>();
  return {
    ...actual,
    default: { ...actual, homedir: () => tmpHome },
    homedir: () => tmpHome,
  };
});

const {
  MEMORY_BASE,
  readMemoryFacts,
  searchMemoryFacts,
  readPendingFacts,
  readPendingUserFacts,
} = await import("./memory-store.js");
const { createMemoryQueryTool, createMemoryWriteTool } = await import(
  "./memory-tools.js"
);

const globalMemoryPath = path.join(MEMORY_BASE, "global", "MEMORY.md");

async function writeGlobalMemory(body: string): Promise<void> {
  await fs.mkdir(path.dirname(globalMemoryPath), { recursive: true });
  await fs.writeFile(globalMemoryPath, body, "utf-8");
}

async function writeUserMemory(userId: string, body: string): Promise<void> {
  const target = path.join(MEMORY_BASE, "users", userId, "MEMORY.md");
  await fs.mkdir(path.dirname(target), { recursive: true });
  await fs.writeFile(target, body, "utf-8");
}

/** Run a tool and return its first text content block. */
async function run(
  tool: { execute: Function },
  params: unknown,
): Promise<string> {
  const result = await tool.execute("call-1", params as never);
  return (result.content[0] as { text: string }).text;
}

const DM = { sessionName: "@alice", userId: "U123" };
const CHANNEL = { sessionName: "#general" };

describe("memory-store read helpers", () => {
  beforeEach(async () => {
    await fs.rm(MEMORY_BASE, { recursive: true, force: true });
  });

  afterAll(async () => {
    await fs.rm(tmpHome, { recursive: true, force: true });
  });

  it("parses MEMORY.md bullets into facts, ignoring headers and blanks", async () => {
    await writeGlobalMemory(
      "# Global memory\n\n- Demo day is Friday.\n\n* Deploys freeze in December.\nnot a bullet\n",
    );
    expect(await readMemoryFacts({ kind: "global" })).toEqual([
      "Demo day is Friday.",
      "Deploys freeze in December.",
    ]);
  });

  it("returns no facts when the scope has no memory file", async () => {
    expect(await readMemoryFacts({ kind: "global" })).toEqual([]);
  });

  it("ranks whole-phrase matches above partial term matches", async () => {
    await writeGlobalMemory(
      "# Global memory\n\n- The deploy freeze runs all December.\n- Deploy scripts live in bin/.\n- Unrelated fact about lunch.\n",
    );
    const hits = await searchMemoryFacts({ kind: "global" }, "deploy freeze");
    expect(hits[0]).toBe("The deploy freeze runs all December.");
    expect(hits).toHaveLength(2); // the lunch fact matches no term
  });

  it("returns every fact in file order for an empty query", async () => {
    await writeGlobalMemory("# Global memory\n\n- One.\n- Two.\n- Three.\n");
    expect(await searchMemoryFacts({ kind: "global" }, "")).toEqual([
      "One.",
      "Two.",
      "Three.",
    ]);
  });

  it("honors the limit", async () => {
    await writeGlobalMemory(
      `# Global memory\n\n${Array.from({ length: 30 }, (_, i) => `- fact ${i}`).join("\n")}\n`,
    );
    expect(await searchMemoryFacts({ kind: "global" }, "fact", 5)).toHaveLength(
      5,
    );
  });
});

describe("memory tools — gating", () => {
  beforeEach(async () => {
    await fs.rm(MEMORY_BASE, { recursive: true, force: true });
    delete process.env.USE_MEMORY_TOOLS;
  });

  it("refuses to read when USE_MEMORY_TOOLS is unset", async () => {
    const out = await run(createMemoryQueryTool(DM), { action: "list" });
    expect(out).toContain("not enabled");
  });

  it("refuses to write when USE_MEMORY_TOOLS is unset", async () => {
    const out = await run(createMemoryWriteTool(DM), {
      facts: ["x"],
      scope: "global",
    });
    expect(out).toContain("not enabled");
    expect(await readPendingFacts()).toEqual([]);
  });
});

describe("memory_query", () => {
  beforeEach(async () => {
    await fs.rm(MEMORY_BASE, { recursive: true, force: true });
    process.env.USE_MEMORY_TOOLS = "true";
  });

  afterEach(() => {
    delete process.env.USE_MEMORY_TOOLS;
  });

  it("reads global memory from a channel", async () => {
    await writeGlobalMemory("# Global memory\n\n- Demo day is Friday.\n");
    const out = await run(createMemoryQueryTool(CHANNEL), {
      action: "list",
      scope: "global",
    });
    expect(out).toContain("Demo day is Friday.");
  });

  it("reads user memory in that user's DM", async () => {
    await writeUserMemory(
      "U123",
      "# Memory for U123\n\n- Alice prefers terse replies.\n",
    );
    const out = await run(createMemoryQueryTool(DM), {
      action: "list",
      scope: "user",
    });
    expect(out).toContain("Alice prefers terse replies.");
  });

  it("refuses user scope from a channel", async () => {
    await writeUserMemory(
      "U123",
      "# Memory for U123\n\n- Alice prefers terse replies.\n",
    );
    const out = await run(createMemoryQueryTool(CHANNEL), {
      action: "list",
      scope: "user",
    });
    expect(out).toContain("only accessible in a direct message");
    expect(out).not.toContain("terse replies");
  });

  it("silently omits user scope from a channel when scope is 'all'", async () => {
    await writeGlobalMemory("# Global memory\n\n- Demo day is Friday.\n");
    await writeUserMemory(
      "U123",
      "# Memory for U123\n\n- Alice prefers terse replies.\n",
    );
    const out = await run(createMemoryQueryTool(CHANNEL), { action: "list" });
    expect(out).toContain("Demo day is Friday.");
    expect(out).not.toContain("terse replies");
    expect(out).not.toContain("User memory");
  });

  it("requires a query for action 'search'", async () => {
    const out = await run(createMemoryQueryTool(DM), {
      action: "search",
      query: "  ",
    });
    expect(out).toContain("requires a non-empty query");
  });

  it("reports empty scopes rather than failing", async () => {
    const out = await run(createMemoryQueryTool(CHANNEL), {
      action: "list",
      scope: "global",
    });
    expect(out).toContain("no matching facts");
  });
});

describe("memory_write", () => {
  beforeEach(async () => {
    await fs.rm(MEMORY_BASE, { recursive: true, force: true });
    process.env.USE_MEMORY_TOOLS = "true";
  });

  afterEach(() => {
    delete process.env.USE_MEMORY_TOOLS;
  });

  it("queues global facts into the pending inbox, not MEMORY.md", async () => {
    const out = await run(createMemoryWriteTool(CHANNEL), {
      facts: ["Demo day is Friday."],
      scope: "global",
    });
    expect(out).toContain("Queued 1 fact(s) for global memory");
    expect(out).toContain("1/10");

    const pending = await readPendingFacts();
    expect(pending).toHaveLength(1);
    expect(pending[0]).toMatchObject({
      text: "Demo day is Friday.",
      sourceSession: "#general",
    });
    // MEMORY.md must be untouched — consolidation is what writes it.
    await expect(fs.readFile(globalMemoryPath, "utf-8")).rejects.toThrow();
  });

  it("queues user facts keyed to the DM's user ID", async () => {
    await run(createMemoryWriteTool(DM), {
      facts: ["Alice leads infra."],
      scope: "user",
    });
    const pending = await readPendingUserFacts("U123");
    expect(pending).toHaveLength(1);
    expect(pending[0].text).toBe("Alice leads infra.");
    expect(await readPendingFacts()).toEqual([]);
  });

  it("refuses user-scoped writes from a channel", async () => {
    const out = await run(createMemoryWriteTool(CHANNEL), {
      facts: ["secret"],
      scope: "user",
    });
    expect(out).toContain("only accessible in a direct message");
    expect(await readPendingFacts()).toEqual([]);
  });

  it("refuses user-scoped writes in a DM with no user ID", async () => {
    const out = await run(createMemoryWriteTool({ sessionName: "@ghost" }), {
      facts: ["x"],
      scope: "user",
    });
    expect(out).toContain("No Slack user ID");
  });

  it("drops blank facts and reports nothing written", async () => {
    const out = await run(createMemoryWriteTool(CHANNEL), {
      facts: ["  ", ""],
      scope: "global",
    });
    expect(out).toContain("nothing written");
    expect(await readPendingFacts()).toEqual([]);
  });

  it("truncates an overlong fact", async () => {
    await run(createMemoryWriteTool(CHANNEL), {
      facts: ["x".repeat(500)],
      scope: "global",
    });
    const [fact] = await readPendingFacts();
    expect(fact.text).toHaveLength(301); // 300 chars + ellipsis
    expect(fact.text.endsWith("…")).toBe(true);
  });

  it("triggers consolidation once the inbox reaches the threshold", async () => {
    const llm = vi.fn(async () => "- Consolidated fact.");
    const tool = createMemoryWriteTool({ ...CHANNEL, consolidateLlm: llm });
    await run(tool, {
      facts: Array.from({ length: 9 }, (_, i) => `fact ${i}`),
      scope: "global",
    });
    expect(llm).not.toHaveBeenCalled();

    await run(tool, { facts: ["fact 9"], scope: "global" });
    // Consolidation is fire-and-forget (an LLM call must not block the
    // tool result), so poll rather than assuming it lands on one tick.
    await vi.waitFor(() => expect(llm).toHaveBeenCalledTimes(1));
    expect(await fs.readFile(globalMemoryPath, "utf-8")).toContain(
      "Consolidated fact.",
    );
  });

  it("does not consolidate when no LLM caller is wired in", async () => {
    const tool = createMemoryWriteTool(CHANNEL);
    await run(tool, {
      facts: Array.from({ length: 12 }, (_, i) => `fact ${i}`),
      scope: "global",
    });
    expect(await readPendingFacts()).toHaveLength(12);
  });
});
