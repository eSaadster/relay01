import {
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import {
  type Api,
  fauxAssistantMessage,
  fauxToolCall,
  type Model,
} from "@earendil-works/pi-ai";
import { registerFauxProvider } from "@earendil-works/pi-ai/compat";
import { Type } from "@sinclair/typebox";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  DurableRouting,
  readDurableFlags,
  SessionMap,
} from "../auto-reply/durable.js";
import { EventsWatcher } from "../auto-reply/events/watcher.js";
import {
  DurableSlack,
  EVENT_KIND,
  LOST_NOTE,
  type SlackWeb,
} from "./durable-slack.js";
import type { SlackContext, SlackEventInput } from "./slack.js";

const home = vi.hoisted(() => {
  const fs = require("node:fs") as typeof import("node:fs");
  const os = require("node:os") as typeof import("node:os");
  const path = require("node:path") as typeof import("node:path");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "relay01-slack-home-"));
  process.env.HOME = dir;
  return dir;
});

const faux = registerFauxProvider({
  provider: "faux-slack",
  models: [{ id: "faux-1", contextWindow: 200_000 }],
});
const model = faux.getModel() as unknown as Model<Api>;
const dirs: string[] = [];
const relays: DurableSlack[] = [];

afterEach(async () => {
  for (const relay of relays.splice(0)) await relay.close().catch(() => {});
  for (const dir of dirs.splice(0))
    rmSync(dir, { recursive: true, force: true });
  rmSync(join(home, "relay01"), { recursive: true, force: true });
  faux.setResponses([]);
});

function tempDir() {
  const dir = mkdtempSync(join(tmpdir(), "relay01-slack-"));
  dirs.push(dir);
  return dir;
}

function put(file: string, text: string) {
  mkdirSync(join(file, ".."), { recursive: true });
  writeFileSync(file, text);
}

function slackTs(offsetMs = 0) {
  return ((Date.now() + offsetMs) / 1000).toFixed(6);
}

function fakeWeb() {
  let n = 0;
  return {
    chat: {
      postMessage: vi.fn(async (_args: Record<string, unknown>) => ({
        ok: true,
        ts: `9${++n}.000000`,
      })),
      update: vi.fn(async (_args: Record<string, unknown>) => ({ ok: true })),
    },
    files: { uploadV2: vi.fn(async () => ({ ok: true })) },
  };
}

type FakeWeb = ReturnType<typeof fakeWeb>;

function fakeContext(
  web: FakeWeb,
  event: SlackEventInput,
  options: { typing?: boolean; hangOnRespond?: boolean } = {},
) {
  let messageTs: string | undefined;
  let thinking = true;
  const shown = { text: "" };
  const show = async (text: string) => {
    shown.text = text;
    if (messageTs)
      await web.chat.update({ channel: event.channel, ts: messageTs, text });
    else
      messageTs = (
        await web.chat.postMessage({
          channel: event.channel,
          text,
          ...(event.thread_ts ? { thread_ts: event.thread_ts } : {}),
        })
      ).ts;
  };
  const respond = vi.fn(async (text: string) => {
    if (options.hangOnRespond) return new Promise<void>(() => {});
    await show(thinking ? text : `${shown.text}\n${text}`);
    thinking = false;
  });
  const ctx: SlackContext = {
    message: {
      text: event.text,
      rawText: event.text,
      user: event.user,
      userName: "alice",
      channel: event.channel,
      ts: event.ts,
      attachments: [],
    },
    store: {} as never,
    channels: [],
    users: [],
    respond,
    replaceMessage: show,
    respondBlocks: async () => {},
    hasRenderedBlocks: () => false,
    respondInThread: async () => {},
    setTyping: async (on) => {
      if (on && !messageTs && options.typing !== false)
        await show("_Thinking_");
    },
    uploadFile: async () => {},
    setWorking: async () => {},
    placeholderTs: () => messageTs,
  };
  return { ctx, shown, respond };
}

function gateTool(name: string) {
  let release: () => void = () => {};
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const state = { entered: 0, release };
  const tool: AgentTool<any> = {
    name,
    label: name,
    description: `The ${name} tool`,
    parameters: Type.Object({}),
    execute: async (_id, _args, signal) => {
      state.entered++;
      await Promise.race([
        gate,
        new Promise((resolve) => signal?.addEventListener("abort", resolve)),
      ]);
      if (signal?.aborted) throw new Error("stopped");
      return {
        content: [{ type: "text", text: "tool finished" }],
        details: undefined,
      };
    },
  };
  return { tool, state };
}

async function startRelay(
  stateDir: string,
  web: FakeWeb,
  tools: AgentTool<any>[] = [],
) {
  const relay = new DurableSlack(new Set(["#ops", "@alice"]), stateDir);
  await relay.start({
    web: web as unknown as SlackWeb,
    getApiKey: async () => "test-key",
    setup: async () => ({ model, systemPrompt: "You are Relay-01.", tools }),
    folderOf: async (_event, source) => (source === "dm" ? "@alice" : "#ops"),
    resolveFolder: async (folder) =>
      folder === "#ops" ? { channel: "C1", isDm: false, folder } : undefined,
    planAttachments: () => [],
    approvalPending: () => false,
    timeoutMs: 20_000,
    selfCorrect: false,
  });
  relays.push(relay);
  return relay;
}

const mention = (text: string, extra: Partial<SlackEventInput> = {}) => ({
  text: `<@UBOT> ${text}`,
  channel: "C1",
  user: "U1",
  ts: slackTs(),
  ...extra,
});

describe("DurableSlack", () => {
  it("runs a redelivered message only once", async () => {
    const web = fakeWeb();
    const relay = await startRelay(tempDir(), web);
    let calls = 0;
    faux.setResponses([
      () => {
        calls++;
        return fauxAssistantMessage("hello back");
      },
    ]);
    const event = mention("hi");
    const ticket = await relay.intake(event, "channel");
    const { ctx, shown } = fakeContext(web, event);
    await ticket?.run?.(ctx);

    expect(await relay.intake(event, "channel")).toEqual({});
    expect(calls).toBe(1);
    expect(shown.text).toBe("hello back");
  });

  it("queues a message that arrives during a run and answers it in its own thread", async () => {
    const web = fakeWeb();
    const { tool, state } = gateTool("bash");
    const relay = await startRelay(tempDir(), web, [tool]);
    faux.setResponses([
      fauxAssistantMessage(fauxToolCall("bash", {}), { stopReason: "toolUse" }),
      fauxAssistantMessage("answer A"),
      fauxAssistantMessage("answer B"),
    ]);
    const a = mention("first");
    const first = fakeContext(web, a);
    const runA = (await relay.intake(a, "channel"))?.run?.(first.ctx);
    await vi.waitFor(() => expect(state.entered).toBe(1));

    const b = mention("second", {
      user: "U2",
      ts: slackTs(1),
      thread_ts: "T9",
    });
    const second = fakeContext(web, b);
    const runB = (await relay.intake(b, "channel"))?.run?.(second.ctx);
    await vi.waitFor(() =>
      expect(web.chat.postMessage).toHaveBeenCalledWith({
        channel: "C1",
        text: "_Queued behind 1 message_",
        thread_ts: "T9",
      }),
    );
    state.release();
    await Promise.all([runA, runB]);

    expect(first.shown.text).toBe("answer A");
    expect(second.shown.text).toBe("answer B");
  });

  it("stop aborts only the current run; the queued message is still answered", async () => {
    const web = fakeWeb();
    const { tool, state } = gateTool("bash");
    const relay = await startRelay(tempDir(), web, [tool]);
    faux.setResponses([
      fauxAssistantMessage(fauxToolCall("bash", {}), { stopReason: "toolUse" }),
      fauxAssistantMessage("answer to B"),
    ]);
    const a = mention("long job");
    const first = fakeContext(web, a);
    const runA = (await relay.intake(a, "channel"))?.run?.(first.ctx);
    await vi.waitFor(() => expect(state.entered).toBe(1));
    const b = mention("B", { user: "U2", ts: slackTs(1) });
    const second = fakeContext(web, b);
    const runB = (await relay.intake(b, "channel"))?.run?.(second.ctx);
    await vi.waitFor(() =>
      expect(second.shown.text).toContain("Queued behind 1"),
    );

    expect(await relay.stop({ channel: "C1", isDm: false })).toBe("stopped");
    await Promise.all([runA, runB]);

    expect(first.shown.text).toBe("_Stopped_");
    expect(second.shown.text).toBe("answer to B");
    expect(await relay.stop({ channel: "C1", isDm: false })).toBe("idle");
  });

  it("delivers a settled but unsent reply at startup by updating its placeholder, once", async () => {
    const stateDir = tempDir();
    const web = fakeWeb();
    const before = await startRelay(stateDir, web);
    faux.setResponses([fauxAssistantMessage("late answer")]);
    const event = mention("hi");
    const crashed = fakeContext(web, event, { hangOnRespond: true });
    void (await before.intake(event, "channel"))?.run?.(crashed.ctx);
    await vi.waitFor(() => expect(crashed.respond).toHaveBeenCalled());
    const placeholder = crashed.ctx.placeholderTs();
    await before.close();

    const after = fakeWeb();
    const restarted = await startRelay(stateDir, after);
    expect(after.chat.update).toHaveBeenCalledWith({
      channel: "C1",
      ts: placeholder,
      text: "late answer",
    });
    expect(after.chat.postMessage).not.toHaveBeenCalled();
    await restarted.close();

    const again = fakeWeb();
    await startRelay(stateDir, again);
    expect(again.chat.update).not.toHaveBeenCalled();
    expect(again.chat.postMessage).not.toHaveBeenCalled();
  });

  it("posts the lost-track note instead of an orphan older than two hours", async () => {
    const stateDir = tempDir();
    const web = fakeWeb();
    const before = await startRelay(stateDir, web);
    faux.setResponses([fauxAssistantMessage("stale answer")]);
    const event = mention("old", { ts: slackTs(-3 * 60 * 60 * 1000) });
    const crashed = fakeContext(web, event, {
      typing: false,
      hangOnRespond: true,
    });
    void (await before.intake(event, "channel"))?.run?.(crashed.ctx);
    await vi.waitFor(() => expect(crashed.respond).toHaveBeenCalled());
    await before.close();

    const after = fakeWeb();
    await startRelay(stateDir, after);
    expect(after.chat.postMessage).toHaveBeenCalledWith({
      channel: "C1",
      text: LOST_NOTE,
      thread_ts: event.ts,
    });
    expect(after.chat.update).not.toHaveBeenCalled();
  });

  it("runs a periodic event once per firing", async () => {
    put(
      join(home, "relay01/slack/#ops/events/tick.json"),
      JSON.stringify({ type: "periodic", cron: "* * * * * *", text: "tick" }),
    );
    const web = fakeWeb();
    const relay = await startRelay(tempDir(), web);
    let calls = 0;
    faux.setResponses(
      Array.from({ length: 6 }, () => () => {
        calls++;
        return fauxAssistantMessage(`tock ${calls}`);
      }),
    );
    const requestIds: string[] = [];
    const watcher = new EventsWatcher();
    await watcher.start({
      webClient: web as never,
      getSessionChannelId: async () => "C1",
      durable: (sessionName, message, requestId) => {
        requestIds.push(requestId);
        return relay.note(sessionName, {
          kind: EVENT_KIND,
          text: message,
          requestId,
        });
      },
    });
    try {
      await vi.waitFor(
        () => expect(web.chat.postMessage).toHaveBeenCalledTimes(2),
        { timeout: 8_000 },
      );
    } finally {
      watcher.stop();
    }

    expect(web.chat.postMessage).toHaveBeenCalledWith({
      channel: "C1",
      text: "tock 2",
    });
    expect(new Set(requestIds).size).toBe(requestIds.length);
    expect(requestIds[0]).toMatch(/^#ops:tick\.json:\d+000$/);
  });

  it("stays on the legacy path and opens no storage when no session is flagged", async () => {
    const slackBase = tempDir();
    const stateDir = tempDir();
    put(join(slackBase, "#plain/.env"), "PI_AGENT_MODEL=x\n");

    expect(DurableSlack.fromEnv({ slackBase, stateDir })).toBeUndefined();
    expect(readdirSync(stateDir)).toEqual([]);
    expect(
      new DurableRouting(
        readDurableFlags(slackBase),
        new SessionMap(null),
      ).route({ channel: "C5", user: "U5", isDm: false, folder: "#plain" }),
    ).toBe("legacy");
  });
});
