// Agent runner — spawns pi CLI child processes (stream-json mode)

import { spawn, type ChildProcess } from "node:child_process";
import { createWriteStream } from "node:fs";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { logVerbose } from "../../globals.js";
import {
  appendEvent,
  getOutputPath,
  saveRunStatus,
} from "./memory.js";
import type { AgentRun, AgentRunStatus, ChainStep } from "./types.js";

/**
 * Parse duration string to milliseconds.
 * Supports: "10s", "5m", "2h", "1d"
 */
export function parseDuration(duration: string): number {
  const match = duration.match(/^(\d+)(s|m|h|d)$/);
  if (!match) {
    throw new Error(`Invalid duration format: ${duration}`);
  }
  const value = parseInt(match[1], 10);
  const unit = match[2];
  switch (unit) {
    case "s":
      return value * 1000;
    case "m":
      return value * 60 * 1000;
    case "h":
      return value * 60 * 60 * 1000;
    case "d":
      return value * 24 * 60 * 60 * 1000;
    default:
      throw new Error(`Unknown duration unit: ${unit}`);
  }
}

export interface RunOptions {
  run: AgentRun;
  session: string;
  prompt: string;
  model?: string;
  timeoutMs: number;
  onStatusChange: (run: AgentRun) => Promise<void>;
  /** Path to definition-level MCP config (mcporter.json) */
  mcpConfigPath?: string;
}

function toTerminalEventType(status: AgentRunStatus): "completed" | "failed" | "timeout" | "stopped" {
  if (status === "completed") return "completed";
  if (status === "timeout") return "timeout";
  if (status === "stopped") return "stopped";
  return "failed";
}

function isStopped(run: AgentRun): boolean {
  return run.status === "stopped";
}

// pi-rlm subagent settings for spawned pi processes.
// Requires @shift-labs/pi-rlm installed in the global pi config
// (`pi install npm:@shift-labs/pi-rlm`) and Bun on PATH.
const RLM_ENV = {
  PI_RLM_MAX_DEPTH: "2",
  PI_RLM_SUBAGENT_MODEL: "opencode-go/deepseek-v4-flash",
};

/**
 * Try to extract result text from stream-json output lines.
 * Parses lines matching {"type":"result",...} or {"type":"text",...}.
 */
function stripAnsi(str: string): string {
  return str
    .replace(/\x1b\[[0-9;]*[mGKHFJABCDsu]/g, "")  // CSI sequences (colors, cursor movement)
    .replace(/\x1b\]8;;.*?\x1b\\/g, "")              // OSC 8 hyperlinks
    .replace(/\x1b\][^\x1b]*\x1b\\/g, "")            // other OSC sequences
    .replace(/\x1b[^[\]]/g, "")                       // other escape sequences
    .replace(/[\x00-\x08\x0b\x0c\x0e-\x1f]/g, "");  // other control chars (keep \n, \t)
}

function extractResultText(stdout: string): string {
  const lines = stdout.split("\n").filter((l) => l.trim());
  for (const line of lines.reverse()) {
    try {
      const obj = JSON.parse(stripAnsi(line)) as Record<string, unknown>;
      if (obj.type === "result" && typeof obj.result === "string") {
        return obj.result;
      }
      if (obj.type === "text" && typeof obj.text === "string") {
        return obj.text;
      }
    } catch {
      // Not JSON, skip
    }
  }
  return "";
}

/**
 * Execute a single agent run by spawning a pi child process.
 * Returns when the process completes (or is killed).
 */
export async function executeRun(options: RunOptions): Promise<AgentRun> {
  const { run, session, prompt, model, timeoutMs, onStatusChange, mcpConfigPath } = options;

  // Write .pi/mcp.json if definition has MCP config
  if (mcpConfigPath) {
    await writeMcpConfig(run.cwd, mcpConfigPath);
  }

  const args = ["--rlm", "--print"];
  if (model) {
    args.push("--model", model);
  }
  args.push(prompt);

  logVerbose(
    `[agents/runner] Spawning pi for run ${run.id}: pi ${args.slice(0, 4).join(" ")}...`,
  );

  const outputPath = getOutputPath(session, run.id);
  const outputStream = createWriteStream(outputPath, { flags: "a" });

  const child: ChildProcess = spawn("pi", args, {
    cwd: run.cwd,
    stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env, ...RLM_ENV },
  });

  run.pid = child.pid;
  run.status = "running";
  await saveRunStatus(session, run);

  await appendEvent(session, run.id, {
    time: new Date().toISOString(),
    type: "started",
    data: `PID ${child.pid}`,
  });

  // Stream stdout and stderr to output.log
  child.stdout?.pipe(outputStream);
  child.stderr?.pipe(outputStream);

  // Collect stdout for result extraction
  let stdout = "";
  child.stdout?.on("data", (chunk: Buffer) => {
    stdout += chunk.toString();
  });

  // Set up timeout
  let timedOut = false;
  const timeoutHandle = setTimeout(() => {
    timedOut = true;
    logVerbose(`[agents/runner] Run ${run.id} timed out, sending SIGTERM`);
    child.kill("SIGTERM");
    // Grace period: SIGKILL after 5s
    setTimeout(() => {
      if (!child.killed) {
        child.kill("SIGKILL");
      }
    }, 5000);
  }, timeoutMs);
  timeoutHandle.unref();

  let settled = false;

  return new Promise<AgentRun>((resolve) => {
    child.on("close", async (code) => {
      if (settled) return;
      settled = true;

      try {
        clearTimeout(timeoutHandle);
        outputStream.end();

        let finalStatus: AgentRunStatus;
        let error: string | undefined;

        if (timedOut) {
          finalStatus = "timeout";
          error = `Timed out after ${Math.round(timeoutMs / 1000)}s`;
        } else if (run.status === "stopped") {
          // Was stopped externally
          finalStatus = "stopped";
        } else if (code === 0) {
          finalStatus = "completed";
        } else {
          finalStatus = "failed";
          error = `Process exited with code ${code}`;
        }

        run.status = finalStatus;
        run.ended = new Date().toISOString();
        run.error = error;
        run.pid = undefined; // Process no longer running

        await saveRunStatus(session, run);

        // In --print mode stdout is plain text (buffered until exit); fall
        // back to it when there is no stream-json result line to parse.
        const resultText =
          finalStatus === "completed"
            ? extractResultText(stdout) || stripAnsi(stdout).trim()
            : undefined;

        await appendEvent(session, run.id, {
          time: new Date().toISOString(),
          type: toTerminalEventType(finalStatus),
          data:
            finalStatus === "stopped"
              ? "Stopped by user"
              : resultText || error || `Exit code ${code}`,
        });

        await onStatusChange(run);
      } catch (handlerErr) {
        logVerbose(`[agents/runner] close handler error for ${run.id}: ${handlerErr}`);
        run.status = "failed";
        run.ended = run.ended ?? new Date().toISOString();
        run.error = run.error ?? `Close handler error: ${handlerErr}`;
        run.pid = undefined;
      } finally {
        resolve(run);
      }
    });

    child.on("error", async (err) => {
      if (settled) return;
      settled = true;

      try {
        clearTimeout(timeoutHandle);
        outputStream.end();

        run.status = "failed";
        run.ended = new Date().toISOString();
        run.error = `Spawn error: ${err.message}`;
        run.pid = undefined;

        await saveRunStatus(session, run);

        await appendEvent(session, run.id, {
          time: new Date().toISOString(),
          type: "failed",
          data: run.error,
        });

        await onStatusChange(run);
      } catch (handlerErr) {
        logVerbose(`[agents/runner] error handler error for ${run.id}: ${handlerErr}`);
        run.status = "failed";
        run.ended = run.ended ?? new Date().toISOString();
        run.error = run.error ?? `Error handler error: ${handlerErr}`;
        run.pid = undefined;
      } finally {
        resolve(run);
      }
    });
  });
}

/**
 * Write .pi/mcp.json in the run's cwd for pi-mcp-adapter discovery.
 * Reads definition-level MCP servers from mcporter.json.
 */
export async function writeMcpConfig(
  runCwd: string,
  mcpConfigPath?: string,
): Promise<void> {
  const mcpConfig: { mcpServers: Record<string, unknown> } = { mcpServers: {} };

  // Merge definition-level MCP servers
  if (mcpConfigPath) {
    try {
      const content = await fs.readFile(mcpConfigPath, "utf-8");
      const parsed = JSON.parse(content);
      if (parsed.mcpServers && typeof parsed.mcpServers === "object") {
        Object.assign(mcpConfig.mcpServers, parsed.mcpServers);
      }
    } catch (err) {
      logVerbose(`[agents/runner] Failed to read MCP config from ${mcpConfigPath}: ${err}`);
    }
  }

  // Only write if there are servers to configure
  if (Object.keys(mcpConfig.mcpServers).length === 0) return;

  const piDir = path.join(runCwd, ".pi");
  await fs.mkdir(piDir, { recursive: true });
  await fs.writeFile(
    path.join(piDir, "mcp.json"),
    JSON.stringify(mcpConfig, null, 2),
  );
  logVerbose(`[agents/runner] Wrote .pi/mcp.json in ${runCwd} with ${Object.keys(mcpConfig.mcpServers).length} server(s)`);
}

export interface ChainRunOptions {
  run: AgentRun;
  session: string;
  steps: ChainStep[];
  task: string;
  model?: string;
  timeoutMs: number;
  onStatusChange: (run: AgentRun) => Promise<void>;
}

/**
 * Execute a chain run — sequential steps with {task}/{previous} substitution.
 * Default policy: stop-on-failure.
 */
export async function executeChainRun(
  options: ChainRunOptions,
): Promise<AgentRun> {
  const { run, session, steps, task, model, timeoutMs, onStatusChange } =
    options;

  run.steps = {
    total: steps.length,
    current: 0,
    results: [],
  };
  await saveRunStatus(session, run);

  let previousOutput = "";
  const perStepTimeout = Math.floor(timeoutMs / steps.length);

  for (let i = 0; i < steps.length; i++) {
    // Allow external stop requests to short-circuit the remaining chain.
    if (isStopped(run)) {
      run.ended = new Date().toISOString();
      run.pid = undefined;
      await saveRunStatus(session, run);
      await appendEvent(session, run.id, {
        time: new Date().toISOString(),
        type: "stopped",
        step: i,
        data: "Chain execution stopped",
      });
      await onStatusChange(run);
      return run;
    }

    const step = steps[i];
    run.steps.current = i;
    run.steps.results.push({
      name: step.name,
      status: "running",
      startedAt: new Date().toISOString(),
    });
    await saveRunStatus(session, run);

    await appendEvent(session, run.id, {
      time: new Date().toISOString(),
      type: "step_started",
      step: i,
      data: step.name,
    });

    // Substitute placeholders
    const prompt = step.prompt
      .replace(/\{task\}/g, task)
      .replace(/\{previous\}/g, previousOutput);

    const outputPath = getOutputPath(session, run.id);

    const args = ["--rlm", "--print"];
    if (model) {
      args.push("--model", model);
    }
    args.push(prompt);

    // Execute step
    const stepResult = await new Promise<{
      code: number | null;
      stdout: string;
      timedOut: boolean;
    }>((resolve) => {
      const outputStream = createWriteStream(outputPath, { flags: "a" });
      const child = spawn("pi", args, {
        cwd: run.cwd,
        stdio: ["ignore", "pipe", "pipe"],
        env: { ...process.env, ...RLM_ENV },
      });

      run.pid = child.pid;

      child.stdout?.pipe(outputStream);
      child.stderr?.pipe(outputStream);

      let stdout = "";
      child.stdout?.on("data", (chunk: Buffer) => {
        stdout += chunk.toString();
      });

      let stepTimedOut = false;
      const stepTimeout = setTimeout(() => {
        stepTimedOut = true;
        child.kill("SIGTERM");
        setTimeout(() => {
          if (!child.killed) child.kill("SIGKILL");
        }, 5000);
      }, perStepTimeout);
      stepTimeout.unref();

      child.on("close", (code) => {
        clearTimeout(stepTimeout);
        outputStream.end();
        resolve({ code, stdout, timedOut: stepTimedOut });
      });

      child.on("error", () => {
        clearTimeout(stepTimeout);
        outputStream.end();
        resolve({ code: 1, stdout: "", timedOut: false });
      });
    });

    run.pid = undefined;

    if (isStopped(run)) {
      run.steps.results[i].status = "stopped";
      run.steps.results[i].endedAt = new Date().toISOString();
      run.steps.results[i].error = "Stopped by user";
      run.ended = new Date().toISOString();
      await saveRunStatus(session, run);
      await appendEvent(session, run.id, {
        time: new Date().toISOString(),
        type: "stopped",
        step: i,
        data: "Stopped by user",
      });
      await onStatusChange(run);
      return run;
    }

    const stepStatus: AgentRunStatus = stepResult.timedOut
      ? "timeout"
      : stepResult.code === 0
        ? "completed"
        : "failed";

    run.steps.results[i].status = stepStatus;
    run.steps.results[i].endedAt = new Date().toISOString();
    if (stepStatus !== "completed") {
      run.steps.results[i].error = stepResult.timedOut
        ? "Step timed out"
        : `Exit code ${stepResult.code}`;
    }

    await appendEvent(session, run.id, {
      time: new Date().toISOString(),
      type:
        stepStatus === "completed" ? "step_completed" : "step_failed",
      step: i,
      data: stepStatus === "completed" ? step.name : run.steps.results[i].error,
    });

    await saveRunStatus(session, run);

    if (stepStatus !== "completed") {
      // Check failure policy
      if (step.onFailure !== "continue") {
        // stop-on-failure (default)
        run.status = "failed";
        run.ended = new Date().toISOString();
        run.error = `Chain stopped at step "${step.name}": ${run.steps.results[i].error}`;
        await saveRunStatus(session, run);
        await onStatusChange(run);
        return run;
      }
    }

    previousOutput = extractResultText(stepResult.stdout) || stepResult.stdout;
  }

  // All steps completed
  run.status = "completed";
  run.ended = new Date().toISOString();
  run.pid = undefined;
  await saveRunStatus(session, run);

  await appendEvent(session, run.id, {
    time: new Date().toISOString(),
    type: "completed",
    data: `Chain completed: ${steps.length} steps`,
  });

  await onStatusChange(run);
  return run;
}

/**
 * Stop a running agent by PID.
 */
export function stopProcess(pid: number): void {
  try {
    process.kill(pid, "SIGTERM");
    // Grace period: SIGKILL after 5s
    setTimeout(() => {
      try {
        process.kill(pid, 0); // Check if still alive
        process.kill(pid, "SIGKILL");
      } catch {
        // Already dead
      }
    }, 5000);
  } catch {
    // Process already dead
  }
}

/**
 * Check if a process is alive by PID.
 */
export function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}
