// RpcChild protocol tests against a scripted fake `pi` binary.

import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import * as path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { RpcChild } from "./rpc-child.js";

const FAKE_PI = `#!/usr/bin/env node
// Fake pi --mode rpc: prompt -> ui question -> settle after answer.
let answered = "";
let buf = "";
process.stdin.on("data", (chunk) => {
  buf += chunk.toString();
  let idx;
  while ((idx = buf.indexOf("\\n")) !== -1) {
    const line = buf.slice(0, idx); buf = buf.slice(idx + 1);
    if (!line.trim()) continue;
    const cmd = JSON.parse(line);
    if (cmd.type === "prompt") {
      out({ type: "response", command: "prompt", success: true });
      out({ type: "agent_start" });
      out({ type: "extension_ui_request", id: "q1", method: "input", title: "Which color?" });
    } else if (cmd.type === "extension_ui_response" && cmd.id === "q1") {
      answered = cmd.value ?? "";
      out({ type: "agent_settled" });
    } else if (cmd.type === "get_last_assistant_text") {
      out({ type: "response", id: cmd.id, command: "get_last_assistant_text", success: true, data: { text: "answer was " + answered } });
    }
  }
});
function out(obj) {
  const s = JSON.stringify(obj);
  // exercise chunked framing: split each line into two writes
  process.stdout.write(s.slice(0, 5));
  process.stdout.write(s.slice(5) + "\\n");
}
`;

let tmpDir: string;
let originalPath: string;

beforeAll(() => {
  tmpDir = mkdtempSync(path.join(os.tmpdir(), "rpc-child-test-"));
  const piPath = path.join(tmpDir, "pi");
  writeFileSync(piPath, FAKE_PI);
  chmodSync(piPath, 0o755);
  originalPath = process.env.PATH ?? "";
  process.env.PATH = `${tmpDir}${path.delimiter}${originalPath}`;
});

afterAll(() => {
  process.env.PATH = originalPath;
  rmSync(tmpDir, { recursive: true, force: true });
});

describe("RpcChild", () => {
  it("round-trips prompt → ui question → answer → settle → result", async () => {
    const child = new RpcChild({
      cwd: tmpDir,
      outputPath: path.join(tmpDir, "output.log"),
    });

    const events: Record<string, unknown>[] = [];
    const uiRequest = new Promise<Record<string, unknown>>((resolve) => {
      child.on("event", (e: Record<string, unknown>) => {
        events.push(e);
        if (e.type === "extension_ui_request") resolve(e);
      });
    });
    const settled = new Promise<void>((resolve) => {
      child.on("event", (e: Record<string, unknown>) => {
        if (e.type === "agent_settled") resolve();
      });
    });

    child.prompt("do the thing");

    const question = await uiRequest;
    expect(question.method).toBe("input");
    expect(question.title).toBe("Which color?");

    child.respondUi(String(question.id), { value: "blue" });
    await settled;

    const text = await child.getLastAssistantText();
    expect(text).toBe("answer was blue");

    // responses must not be re-emitted as events
    expect(events.every((e) => e.type !== "response")).toBe(true);

    child.kill();
  }, 10000);
});
