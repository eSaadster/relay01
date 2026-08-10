// RpcChild — thin JSONL client for a `pi --mode rpc` child process.
//
// We intentionally do not depend on @earendil-works/pi-coding-agent's RpcClient
// (not a repo dependency, version-skewed vs our pinned pi-agent-core). The RPC
// protocol is stable JSONL over stdin/stdout — see pi's docs/rpc.md.

import { type ChildProcess, spawn } from "node:child_process";
import { EventEmitter } from "node:events";
import { createWriteStream, type WriteStream } from "node:fs";
import { logVerbose } from "../../globals.js";

export interface RpcChildOptions {
  cwd: string;
  /** Model pattern passed to --model */
  model?: string;
  /** Extension file paths passed via --extension */
  extensions?: string[];
  /** File that receives raw stdout/stderr for debugging (appended) */
  outputPath: string;
  /** Extra environment variables */
  env?: Record<string, string>;
}

interface PendingRequest {
  resolve: (data: unknown) => void;
  reject: (err: Error) => void;
}

/**
 * One pi RPC child process. Emits:
 * - "event"  — every parsed JSON line from stdout (responses excluded)
 * - "close"  — (code: number | null) when the process exits
 */
export class RpcChild extends EventEmitter {
  private child: ChildProcess;
  private outputStream: WriteStream;
  private buffer = "";
  private seq = 0;
  private pending = new Map<string, PendingRequest>();
  private killed = false;

  constructor(options: RpcChildOptions) {
    super();

    const args = ["--rlm", "--mode", "rpc", "--no-session"];
    if (options.model) {
      args.push("--model", options.model);
    }
    for (const ext of options.extensions ?? []) {
      args.push("--extension", ext);
    }

    this.outputStream = createWriteStream(options.outputPath, { flags: "a" });

    this.child = spawn("pi", args, {
      cwd: options.cwd,
      stdio: ["pipe", "pipe", "pipe"],
      env: { ...process.env, ...options.env },
    });

    // Strict JSONL framing: split on \n only (readline is not protocol-safe —
    // it also splits on U+2028/U+2029, which are valid inside JSON strings).
    this.child.stdout?.on("data", (chunk: Buffer) => {
      const text = chunk.toString("utf-8");
      this.outputStream.write(text);
      this.buffer += text;
      while (true) {
        const idx = this.buffer.indexOf("\n");
        if (idx === -1) break;
        let line = this.buffer.slice(0, idx);
        this.buffer = this.buffer.slice(idx + 1);
        if (line.endsWith("\r")) line = line.slice(0, -1);
        if (line.trim()) this.handleLine(line);
      }
    });

    this.child.stderr?.pipe(this.outputStream);

    this.child.on("close", (code) => {
      this.outputStream.end();
      for (const req of this.pending.values()) {
        req.reject(new Error("pi RPC process exited"));
      }
      this.pending.clear();
      this.emit("close", code);
    });

    this.child.on("error", (err) => {
      this.emit("spawn_error", err);
    });
  }

  get pid(): number | undefined {
    return this.child.pid;
  }

  private handleLine(line: string): void {
    let obj: Record<string, unknown>;
    try {
      obj = JSON.parse(line) as Record<string, unknown>;
    } catch {
      return; // non-JSON noise (e.g. dotenv banners)
    }

    if (obj.type === "response" && typeof obj.id === "string") {
      const req = this.pending.get(obj.id);
      if (req) {
        this.pending.delete(obj.id);
        if (obj.success === false) {
          req.reject(new Error(String(obj.error ?? "RPC command failed")));
        } else {
          req.resolve(obj.data);
        }
        return;
      }
    }

    if (obj.type !== "response") {
      this.emit("event", obj);
    }
  }

  /** Send a raw command (no response tracking). */
  send(cmd: Record<string, unknown>): void {
    if (!this.child.stdin?.writable) return;
    this.child.stdin.write(`${JSON.stringify(cmd)}\n`);
  }

  /** Send a command and await its correlated response's data. */
  request(cmd: Record<string, unknown>, timeoutMs = 15000): Promise<unknown> {
    const id = `req-${++this.seq}`;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`RPC request timed out: ${String(cmd.type)}`));
      }, timeoutMs);
      timer.unref();
      this.pending.set(id, {
        resolve: (data) => {
          clearTimeout(timer);
          resolve(data);
        },
        reject: (err) => {
          clearTimeout(timer);
          reject(err);
        },
      });
      this.send({ ...cmd, id });
    });
  }

  prompt(message: string): void {
    this.send({ type: "prompt", message });
  }

  steer(message: string): void {
    this.send({ type: "steer", message });
  }

  abort(): void {
    this.send({ type: "abort" });
  }

  /** Answer a pending extension_ui_request dialog. */
  respondUi(requestId: string, payload: Record<string, unknown>): void {
    this.send({ type: "extension_ui_response", id: requestId, ...payload });
  }

  async getLastAssistantText(): Promise<string | undefined> {
    try {
      const data = (await this.request({ type: "get_last_assistant_text" })) as
        | { text?: string | null }
        | undefined;
      return data?.text ?? undefined;
    } catch (err) {
      logVerbose(`[agents/rpc-child] get_last_assistant_text failed: ${err}`);
      return undefined;
    }
  }

  /** SIGTERM, then SIGKILL after a grace period. */
  kill(): void {
    if (this.killed) return;
    this.killed = true;
    try {
      this.child.kill("SIGTERM");
    } catch {
      // already dead
    }
    const killTimer = setTimeout(() => {
      try {
        this.child.kill("SIGKILL");
      } catch {
        // already dead
      }
    }, 5000);
    killTimer.unref();
  }
}
