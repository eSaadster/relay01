import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import {
  type Api,
  fauxAssistantMessage,
  fauxToolCall,
  type Message,
  type Model,
  type TranscriptContext,
} from "@earendil-works/pi-ai";
import { registerFauxProvider } from "@earendil-works/pi-ai/compat";
import { Type } from "@sinclair/typebox";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  type ChatRuntime,
  DurableHost,
  DurableRouting,
  RefusedSession,
  readDurableFlags,
  type SlackEntryData,
} from "./durable.js";

const home = vi.hoisted(() => {
  const fs = require("node:fs") as typeof import("node:fs");
  const os = require("node:os") as typeof import("node:os");
  const path = require("node:path") as typeof import("node:path");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "relay01-durable-home-"));
  process.env.HOME = dir;
  return dir;
});

const faux = registerFauxProvider({
  provider: "faux-relay",
  models: [{ id: "faux-1", contextWindow: 200_000 }],
});
const model = faux.getModel() as unknown as Model<Api>;
const dirs: string[] = [];
const hosts: DurableHost[] = [];

afterEach(async () => {
  for (const host of hosts.splice(0)) await host.close().catch(() => {});
  for (const dir of dirs.splice(0))
    rmSync(dir, { recursive: true, force: true });
  rmSync(join(home, "relay01"), { recursive: true, force: true });
  faux.setResponses([]);
});

function tempDir() {
  const dir = mkdtempSync(join(tmpdir(), "relay01-durable-"));
  dirs.push(dir);
  return dir;
}

function put(file: string, text: string) {
  mkdirSync(join(file, ".."), { recursive: true });
  writeFileSync(file, text);
}

async function openHost(stateDir = tempDir()) {
  const host = await DurableHost.open({
    getApiKey: async () => "test-key",
    stateDir,
    onUnexpectedClose: vi.fn(),
  });
  hosts.push(host);
  return host;
}

const setup = (tools: AgentTool<any>[] = []) => ({
  model,
  systemPrompt: "You are Relay-01.",
  tools,
});

const ask = (
  runtime: ChatRuntime,
  text: string,
  data: Partial<SlackEntryData> = {},
  requestId?: string,
) =>
  runtime.ask({
    text,
    entry: {
      kind: "slack.message",
      data: { channel: "C1", source: "channel", ...data },
    },
    requestId,
    timeoutMs: 20_000,
  });

function systemText(context: TranscriptContext) {
  const first = context.messages[0];
  if (first?.role !== "system") return "";
  const content =
    typeof first.content === "string"
      ? first.content
      : first.content.map((c) => c.text).join("");
  return [content, ...Object.values(first.sections ?? {})].join("\n");
}

function blockingTool(name: string, counter: { runs: number }): AgentTool<any> {
  return {
    name,
    label: name,
    description: `The ${name} tool`,
    parameters: Type.Object({}),
    execute: async (_id, _args, signal) => {
      counter.runs++;
      if (counter.runs === 1) {
        await new Promise((resolve) =>
          signal?.addEventListener("abort", resolve),
        );
        throw new Error("stopped");
      }
      return {
        content: [{ type: "text", text: "tool finished" }],
        details: undefined,
      };
    },
  };
}

async function runAcrossRestart(toolName: string) {
  const stateDir = tempDir();
  const counter = { runs: 0 };
  const tool = blockingTool(toolName, counter);
  let seen: readonly Message[] = [];
  faux.setResponses([
    fauxAssistantMessage(fauxToolCall(toolName, {}), { stopReason: "toolUse" }),
    (context) => {
      seen = context.messages;
      return fauxAssistantMessage("Finished after the restart.");
    },
  ]);
  const before = await openHost(stateDir);
  const { key } = await before.ensureSession({
    channel: "C1",
    isDm: false,
    folder: "#ops",
  });
  const interrupted = await before.attach(key, setup([tool]));
  await before.resume();
  void ask(interrupted, "go", {}, "C1:1").catch(() => {});
  await vi.waitFor(() => expect(counter.runs).toBe(1));
  await before.close();

  const after = await openHost(stateDir);
  const pending = await after.pending();
  expect(pending.get(key)?.size).toBe(1);
  const delivered = vi.fn();
  await after.attach(key, setup([tool]), pending.get(key), delivered);
  await after.resume();
  await vi.waitFor(() => expect(delivered).toHaveBeenCalled(), {
    timeout: 10_000,
  });
  const result = seen.find((m) => m.role === "toolResult");
  const resultText =
    result?.role === "toolResult"
      ? result.content.map((c) => (c.type === "text" ? c.text : "")).join("")
      : "";
  return {
    runs: counter.runs,
    delivered: delivered.mock.calls[0],
    resultText,
    stateDir,
  };
}

describe("DurableHost", () => {
  it("injects global memory everywhere, user memory only in its owner's DM, and the session's critical bullets", async () => {
    put(join(home, "relay01/memory/global/MEMORY.md"), "- GLOBAL-FACT-1");
    put(join(home, "relay01/memory/users/U1/MEMORY.md"), "- USER-FACT");
    put(
      join(home, "relay01/slack/@alice/scratchpad/session.md"),
      "## critical\n- CRIT-ALICE\n",
    );
    const host = await openHost();
    const dm = await host.ensureSession({
      channel: "D1",
      user: "U1",
      isDm: true,
      folder: "@alice",
    });
    const channel = await host.ensureSession({
      channel: "C1",
      user: "U1",
      isDm: false,
      folder: "#general",
    });
    const dmRuntime = await host.attach(dm.key, setup());
    const channelRuntime = await host.attach(channel.key, setup());
    await host.resume();
    const prompts: string[] = [];
    const capture = (context: TranscriptContext) => {
      prompts.push(systemText(context));
      return fauxAssistantMessage("ok");
    };
    faux.setResponses([capture, capture, capture]);

    await ask(dmRuntime, "hi", { channel: "D1", user: "U1", source: "dm" });
    put(join(home, "relay01/memory/global/MEMORY.md"), "- GLOBAL-FACT-2");
    await ask(channelRuntime, "hi", {
      channel: "C1",
      user: "U1",
      source: "channel",
    });
    await ask(dmRuntime, "hi", { channel: "D1", user: "U2", source: "dm" });

    expect(prompts[0]).toContain("GLOBAL-FACT-1");
    expect(prompts[0]).toContain("## About @alice");
    expect(prompts[0]).toContain("USER-FACT");
    expect(prompts[0]).toContain("- CRIT-ALICE");
    expect(prompts[0]).toContain("You are Relay-01.");
    expect(prompts[1]).toContain("GLOBAL-FACT-2");
    expect(prompts[1]).not.toContain("USER-FACT");
    expect(prompts[1]).not.toContain("CRIT-ALICE");
    expect(prompts[2]).toContain("GLOBAL-FACT-2");
    expect(prompts[2]).toContain("CRIT-ALICE");
    expect(prompts[2]).not.toContain("USER-FACT");
  });

  it("keys conversations by Slack ids, keeps the mapping across a reopen, and refuses fallback sessions", async () => {
    const stateDir = tempDir();
    const first = await openHost(stateDir);
    const dm = await first.ensureSession({
      channel: "D9",
      user: "U9",
      isDm: true,
      folder: "@bob",
    });
    expect(dm.key).toBe("D9:U9");
    for (const folder of ["@unknown", "@user", "@U8"])
      await expect(
        first.ensureSession({ channel: "D8", user: "U8", isDm: true, folder }),
      ).rejects.toThrow(RefusedSession);
    await first.close();
    for (const file of ["durable.sqlite", "durable-sessions.json"])
      expect(statSync(join(stateDir, file)).mode & 0o777).toBe(0o600);

    const second = await openHost(stateDir);
    const again = await second.ensureSession({
      channel: "D9",
      user: "U9",
      isDm: true,
      folder: "@bob-renamed",
    });
    expect(again.entry).toEqual({
      conversationId: dm.entry.conversationId,
      folder: "@bob",
      userId: "U9",
      isDm: true,
    });
    expect(
      await second.harness.conversation(
        dm.entry.conversationId,
        BACKGROUND_CONTEXT,
      ),
    ).toBeDefined();

    const slackBase = tempDir();
    put(join(slackBase, "#flagged/.env"), "USE_DURABLE=true\n");
    put(join(slackBase, "@unknown/.env"), "USE_DURABLE=true\n");
    put(join(slackBase, "#plain/.env"), "PI_AGENT_MODEL=x\n");
    const routing = new DurableRouting(
      readDurableFlags(slackBase),
      second.sessions,
    );
    expect([...routing.flagged].sort()).toEqual(["#flagged", "@unknown"]);
    expect(
      routing.route({
        channel: "D9",
        user: "U9",
        isDm: true,
        folder: "@whoever",
      }),
    ).toBe("durable");
    expect(
      routing.route({
        channel: "C5",
        user: "U9",
        isDm: false,
        folder: "#plain",
      }),
    ).toBe("legacy");
    expect(
      routing.route({
        channel: "C6",
        user: "U9",
        isDm: false,
        folder: "#flagged",
      }),
    ).toBe("durable");
    expect(
      routing.route({
        channel: "D7",
        user: "U7",
        isDm: true,
        folder: "@unknown",
      }),
    ).toBe("refused");
  });

  it("resumes a run after the harness is closed and reopened mid-run", async () => {
    const { delivered } = await runAcrossRestart("bash");
    const [record, text] = delivered;
    expect(record).toMatchObject({ status: "done", requestId: "C1:1" });
    expect(text).toBe("Finished after the restart.");
  });

  it("reruns an interrupted replay-safe tool and gives the model an interrupted result for an unsafe one", async () => {
    const safe = await runAcrossRestart("read_file");
    expect(safe.runs).toBe(2);
    expect(safe.resultText).toBe("tool finished");
    const unsafe = await runAcrossRestart("bash");
    expect(unsafe.runs).toBe(1);
    expect(unsafe.resultText).toMatch(/interrupted/i);
  });

  it("stops the current run without withdrawing a queued input, which then runs", async () => {
    const counter = { runs: 0 };
    const host = await openHost();
    const { key } = await host.ensureSession({
      channel: "C1",
      isDm: false,
      folder: "#ops",
    });
    const runtime = await host.attach(
      key,
      setup([blockingTool("bash", counter)]),
    );
    await host.resume();
    faux.setResponses([
      fauxAssistantMessage(fauxToolCall("bash", {}), { stopReason: "toolUse" }),
      fauxAssistantMessage("answer to B"),
    ]);
    const first = ask(runtime, "A", { user: "U1" }, "C1:A");
    await vi.waitFor(() => expect(counter.runs).toBe(1));
    const second = ask(runtime, "B", { user: "U2" }, "C1:B");
    await vi.waitFor(() => expect(runtime.status().queueLength).toBe(1));

    expect(await runtime.stopCurrentRun()).toBe(true);

    expect((await first).unanswered?.reason).toBe("aborted");
    expect((await second).text).toBe("answer to B");
  });
});
