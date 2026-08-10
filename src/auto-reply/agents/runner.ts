// Agent runner — spawns pi CLI child processes (RPC mode)

import * as fs from "node:fs/promises";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { logVerbose } from "../../globals.js";
import {
  appendEvent,
  getOutputPath,
  saveRunStatus,
} from "./memory.js";
import { RpcChild } from "./rpc-child.js";
import type {
  AgentRun,
  AgentRunStatus,
  ChainStep,
  PendingQuestion,
} from "./types.js";

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
  /** Called when the run asks the user a question via the ask_user tool */
  onQuestion?: (run: AgentRun, question: PendingQuestion) => Promise<void>;
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

// Path to the ask_user pi extension (repo root /pi-extensions), valid from
// both src/ (tsx) and dist/ builds — three levels up from this module.
const ASK_USER_EXTENSION = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../..",
  "pi-extensions/ask-user.ts",
);

// Live RPC children by run id, so the manager can steer/answer/abort mid-run.
const liveChildren = new Map<string, RpcChild>();

export function getLiveChild(runId: string): RpcChild | undefined {
  return liveChildren.get(runId);
}

/**
 * Queue a steering message into a running RPC child.
 */
export async function steerRun(
  run: AgentRun,
  session: string,
  message: string,
): Promise<boolean> {
  const child = liveChildren.get(run.id);
  if (!child) return false;
  child.steer(message);
  await appendEvent(session, run.id, {
    time: new Date().toISOString(),
    type: "steered",
    data: message,
  });
  return true;
}

/**
 * Answer a run's pending ask_user question.
 */
export async function answerRun(
  run: AgentRun,
  session: string,
  text: string,
): Promise<boolean> {
  const child = liveChildren.get(run.id);
  const question = run.pendingQuestion;
  if (!child || !question) return false;

  if (question.method === "confirm") {
    child.respondUi(question.id, {
      confirmed: /^(y|yes|true|ok|confirm|allow|sure)\b/i.test(text.trim()),
    });
  } else {
    child.respondUi(question.id, { value: text });
  }

  run.pendingQuestion = undefined;
  if (run.status === "waiting_input") run.status = "running";
  await saveRunStatus(session, run);
  await appendEvent(session, run.id, {
    time: new Date().toISOString(),
    type: "question_answered",
    data: text,
  });
  return true;
}

const DIALOG_METHODS = new Set(["input", "select", "confirm", "editor"]);

interface RpcPromptResult {
  status: Extract<AgentRunStatus, "completed" | "failed" | "timeout" | "stopped">;
  resultText?: string;
  error?: string;
}

/**
 * Run a single prompt through a pi RPC child to completion.
 * Shared by executeRun (single runs) and executeChainRun (per step).
 */
async function runRpcPrompt(options: {
  run: AgentRun;
  session: string;
  prompt: string;
  model?: string;
  timeoutMs: number;
  onQuestion?: (run: AgentRun, question: PendingQuestion) => Promise<void>;
  /** Append a "started" event with the child PID (single runs) */
  emitStarted?: boolean;
}): Promise<RpcPromptResult> {
  const { run, session, prompt, model, timeoutMs, onQuestion } = options;

  const child = new RpcChild({
    cwd: run.cwd,
    model,
    extensions: [ASK_USER_EXTENSION],
    outputPath: getOutputPath(session, run.id),
    env: RLM_ENV,
  });

  liveChildren.set(run.id, child);
  run.pid = child.pid;
  await saveRunStatus(session, run);

  if (options.emitStarted) {
    await appendEvent(session, run.id, {
      time: new Date().toISOString(),
      type: "started",
      data: `PID ${child.pid}`,
    });
  }

  let timedOut = false;
  const timeoutHandle = setTimeout(() => {
    timedOut = true;
    logVerbose(`[agents/runner] Run ${run.id} timed out, aborting`);
    child.abort();
    // Grace period, then kill (SIGTERM → SIGKILL)
    setTimeout(() => child.kill(), 5000).unref();
  }, timeoutMs);
  timeoutHandle.unref();

  let settledSeen = false;
  let resultText: string | undefined;

  return new Promise<RpcPromptResult>((resolve) => {
    child.on("event", (event: Record<string, unknown>) => {
      void (async () => {
        try {
          const type = String(event.type ?? "");

          // A run resuming while a question is still marked pending means the
          // dialog auto-resolved on the pi side (timeout) without our answer.
          if (
            run.pendingQuestion &&
            !type.startsWith("extension_ui") &&
            type !== "queue_update"
          ) {
            run.pendingQuestion = undefined;
            if (run.status === "waiting_input") run.status = "running";
            await saveRunStatus(session, run);
            await appendEvent(session, run.id, {
              time: new Date().toISOString(),
              type: "question_answered",
              data: "(question expired unanswered — run continued)",
            });
          }

          if (type === "extension_ui_request") {
            const method = String(event.method ?? "");
            if (DIALOG_METHODS.has(method)) {
              const question: PendingQuestion = {
                id: String(event.id),
                method,
                title: String(event.title ?? event.message ?? ""),
                options: Array.isArray(event.options)
                  ? (event.options as string[])
                  : undefined,
                askedAt: new Date().toISOString(),
              };
              run.pendingQuestion = question;
              if (run.status === "running") run.status = "waiting_input";
              await saveRunStatus(session, run);
              await appendEvent(session, run.id, {
                time: new Date().toISOString(),
                type: "question_asked",
                data: question.title,
              });
              if (onQuestion) await onQuestion(run, question);
            } else if (method === "notify") {
              await appendEvent(session, run.id, {
                time: new Date().toISOString(),
                type: "output",
                data: String(event.message ?? ""),
              });
            }
            return;
          }

          if (type === "agent_settled" && !settledSeen) {
            settledSeen = true;
            resultText = await child.getLastAssistantText();
            child.kill();
          }
        } catch (err) {
          logVerbose(`[agents/runner] Event handler error for ${run.id}: ${err}`);
        }
      })();
    });

    child.on("spawn_error", (err: Error) => {
      clearTimeout(timeoutHandle);
      liveChildren.delete(run.id);
      resolve({ status: "failed", error: `Spawn error: ${err.message}` });
    });

    child.on("close", (code: number | null) => {
      clearTimeout(timeoutHandle);
      liveChildren.delete(run.id);

      if (timedOut) {
        resolve({
          status: "timeout",
          error: `Timed out after ${Math.round(timeoutMs / 1000)}s`,
        });
      } else if (run.status === "stopped") {
        resolve({ status: "stopped" });
      } else if (settledSeen) {
        resolve({ status: "completed", resultText });
      } else {
        resolve({
          status: "failed",
          error: `Process exited with code ${code} before settling`,
        });
      }
    });

    child.prompt(prompt);
  });
}

/**
 * Execute a single agent run by spawning a pi child process.
 * Returns when the process completes (or is killed).
 */
export async function executeRun(options: RunOptions): Promise<AgentRun> {
  const {
    run,
    session,
    prompt,
    model,
    timeoutMs,
    onStatusChange,
    mcpConfigPath,
    onQuestion,
  } = options;

  // Write .pi/mcp.json if definition has MCP config
  if (mcpConfigPath) {
    await writeMcpConfig(run.cwd, mcpConfigPath);
  }

  logVerbose(`[agents/runner] Spawning pi (RPC mode) for run ${run.id}`);

  run.status = "running";
  await saveRunStatus(session, run);

  const result = await runRpcPrompt({
    run,
    session,
    prompt,
    model,
    timeoutMs,
    onQuestion,
    emitStarted: true,
  });

  try {
    run.status = result.status;
    run.ended = new Date().toISOString();
    run.error = result.error;
    run.pid = undefined;
    run.pendingQuestion = undefined;

    await saveRunStatus(session, run);

    await appendEvent(session, run.id, {
      time: new Date().toISOString(),
      type: toTerminalEventType(result.status),
      data:
        result.status === "stopped"
          ? "Stopped by user"
          : result.resultText || result.error || result.status,
    });

    await onStatusChange(run);
  } catch (handlerErr) {
    logVerbose(`[agents/runner] finalize error for ${run.id}: ${handlerErr}`);
    run.status = "failed";
    run.ended = run.ended ?? new Date().toISOString();
    run.error = run.error ?? `Finalize error: ${handlerErr}`;
    run.pid = undefined;
  }
  return run;
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
  /** Called when a step asks the user a question via the ask_user tool */
  onQuestion?: (run: AgentRun, question: PendingQuestion) => Promise<void>;
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

    // Execute step through an RPC child
    const stepResult = await runRpcPrompt({
      run,
      session,
      prompt,
      model,
      timeoutMs: perStepTimeout,
      onQuestion: options.onQuestion,
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

    const stepStatus: AgentRunStatus = stepResult.status;

    run.steps.results[i].status = stepStatus;
    run.steps.results[i].endedAt = new Date().toISOString();
    if (stepStatus !== "completed") {
      run.steps.results[i].error =
        stepStatus === "timeout" ? "Step timed out" : stepResult.error;
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

    previousOutput = stepResult.resultText ?? "";
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
