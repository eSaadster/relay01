// AgentRunManager — singleton lifecycle management for agent runs

import { randomBytes } from "node:crypto";
import os from "node:os";
import * as path from "node:path";
import { logVerbose } from "../../globals.js";
import {
  createAdHocDefinition,
  discoverDefinitions,
  expandPath,
  loadDefinition,
} from "./discovery.js";
import {
  archiveRun,
  findRunById,
  initializeRunDirectory,
  listAllActiveRuns,
  readOutput,
  registerAgentSession,
  saveRunStatus,
  unregisterAgentSessionIfEmpty,
} from "./memory.js";
import {
  executeChainRun,
  executeRun,
  isProcessAlive,
  parseDuration,
  stopProcess,
} from "./runner.js";
import type {
  AgentDefinition,
  AgentRun,
  AgentRunManagerConfig,
  ChainStep,
} from "./types.js";

/**
 * Generate a unique run ID.
 */
function generateRunId(definitionId: string): string {
  const suffix = randomBytes(4).toString("hex");
  return `${definitionId}-${suffix}`;
}

/**
 * Get the default cwd for a session's scratchpad.
 */
function getSessionScratchpad(session: string): string {
  return path.join(os.homedir(), "relay01", "slack", session, "scratchpad");
}

/**
 * AgentRunManager handles the lifecycle of agent runs.
 */
export class AgentRunManager {
  private config: AgentRunManagerConfig;
  private activeRuns: Map<string, { run: AgentRun; session: string }> =
    new Map();
  private orphanMonitors: Map<string, NodeJS.Timeout> = new Map();

  constructor(config: AgentRunManagerConfig) {
    this.config = config;
  }

  private stopOrphanMonitor(runId: string): void {
    const timer = this.orphanMonitors.get(runId);
    if (timer) {
      clearInterval(timer);
      this.orphanMonitors.delete(runId);
    }
  }

  /**
   * For resumed runs we cannot reattach child listeners, so poll PID liveness
   * and finalize once the process exits.
   */
  private startOrphanMonitor(runId: string): void {
    if (this.orphanMonitors.has(runId)) return;

    let checking = false;
    const timer = setInterval(() => {
      if (checking) return;
      checking = true;

      void (async () => {
        try {
          const active = this.activeRuns.get(runId);
          if (!active) {
            this.stopOrphanMonitor(runId);
            return;
          }

          const { run, session } = active;

          // Stop requested while between chain steps (no active child PID).
          if (!run.pid && run.status === "stopped") {
            run.ended = run.ended ?? new Date().toISOString();
            await saveRunStatus(session, run);
            this.activeRuns.delete(runId);
            this.stopOrphanMonitor(runId);
            await this.handleRunComplete(run, session);
            return;
          }

          if (!run.pid || isProcessAlive(run.pid)) {
            return;
          }

          const found = await findRunById(runId);
          if (!found) {
            this.activeRuns.delete(runId);
            this.stopOrphanMonitor(runId);
            return;
          }

          const finalRun = found.run;
          if (finalRun.status === "running") {
            finalRun.status = "failed";
            finalRun.error = "Process exited while manager was detached";
          }
          finalRun.ended = finalRun.ended ?? new Date().toISOString();
          finalRun.pid = undefined;
          await saveRunStatus(session, finalRun);

          this.activeRuns.delete(runId);
          this.stopOrphanMonitor(runId);
          await this.handleRunComplete(finalRun, session);
        } catch (err) {
          logVerbose(`[agents/manager] Orphan monitor error for ${runId}: ${err}`);
        } finally {
          checking = false;
        }
      })();
    }, 2000);
    timer.unref();
    this.orphanMonitors.set(runId, timer);
  }

  /**
   * Start a new agent run.
   */
  async startRun(options: {
    definitionId?: string;
    userPrompt: string;
    session: string;
    cwd?: string;
  }): Promise<AgentRun> {
    const { definitionId, userPrompt, session, cwd } = options;

    // Check concurrent limit
    if (this.activeRuns.size >= this.config.maxConcurrent) {
      throw new Error(
        `Maximum concurrent agents (${this.config.maxConcurrent}) reached`,
      );
    }

    // Load or create definition
    let definition: AgentDefinition;
    if (definitionId) {
      const loaded = await loadDefinition(
        this.config.definitionsPath,
        definitionId,
      );
      if (!loaded) {
        throw new Error(`Agent definition not found: ${definitionId}`);
      }
      definition = loaded;
    } else {
      definition = createAdHocDefinition(userPrompt);
    }

    // Check if this is a chain definition
    if (definition.isChain) {
      return this.startChainRun({
        definition,
        userPrompt,
        session,
        cwd,
      });
    }

    const runId = generateRunId(definition.id);
    const defaultCwd = getSessionScratchpad(session);
    const resolvedCwd = expandPath(cwd || definition.config.cwd || defaultCwd);
    const timeoutMs = parseDuration(definition.config.timeout || "30m");

    const run: AgentRun = {
      version: 1,
      id: runId,
      definitionId: definition.id,
      session,
      cwd: resolvedCwd,
      status: "running",
      started: new Date().toISOString(),
      userPrompt,
    };

    logVerbose(`[agents/manager] Starting run: ${runId}`);

    // Initialize run directory
    await initializeRunDirectory(session, run);

    // Register session
    registerAgentSession(session);

    // Track active run
    this.activeRuns.set(runId, { run, session });

    // Build prompt with definition instructions
    const fullPrompt = definition.instructions
      ? `${definition.instructions}\n\n## Task\n${userPrompt}`
      : userPrompt;

    // No start notification here: every caller (agent_run tool, command
    // handler, CLI, admin API) already confirms the start in its own reply.

    const onStatusChange = async (updatedRun: AgentRun) => {
      this.stopOrphanMonitor(runId);
      this.activeRuns.delete(runId);
      await this.handleRunComplete(updatedRun, session);
    };

    const handleError = async (err: unknown) => {
      logVerbose(`[agents/manager] Run ${runId} error: ${err}`);
      this.stopOrphanMonitor(runId);
      this.activeRuns.delete(runId);
      run.status = "failed";
      run.ended = run.ended ?? new Date().toISOString();
      run.error = run.error ?? `Run error: ${err}`;
      run.pid = undefined;
      try {
        await saveRunStatus(session, run);
        await this.handleRunComplete(run, session);
      } catch (finalizeErr) {
        logVerbose(`[agents/manager] Failed to finalize run ${runId}: ${finalizeErr}`);
      }
    };

    // Execute asynchronously (fire and forget)
    executeRun({
      run,
      session,
      prompt: fullPrompt,
      model: definition.config.model,
      mcpConfigPath: definition.mcpConfigPath,
      timeoutMs,
      onStatusChange,
    }).catch(handleError);

    return run;
  }

  /**
   * Start a chain run.
   */
  private async startChainRun(options: {
    definition: AgentDefinition;
    userPrompt: string;
    session: string;
    cwd?: string;
  }): Promise<AgentRun> {
    const { definition, userPrompt, session, cwd } = options;

    let steps: ChainStep[];
    try {
      steps = JSON.parse(definition.instructions) as ChainStep[];
    } catch {
      throw new Error(
        `Invalid chain definition: ${definition.id} — could not parse steps`,
      );
    }

    const runId = generateRunId(definition.id);
    const defaultCwd = getSessionScratchpad(session);
    const resolvedCwd = expandPath(cwd || definition.config.cwd || defaultCwd);
    const timeoutMs = parseDuration(definition.config.timeout || "1h");

    const run: AgentRun = {
      version: 1,
      id: runId,
      definitionId: definition.id,
      session,
      cwd: resolvedCwd,
      status: "running",
      started: new Date().toISOString(),
      userPrompt,
    };

    logVerbose(
      `[agents/manager] Starting chain run: ${runId} (${steps.length} steps)`,
    );

    await initializeRunDirectory(session, run);
    registerAgentSession(session);
    this.activeRuns.set(runId, { run, session });

    // No start notification (callers confirm the start in their own reply)

    // Execute chain asynchronously
    executeChainRun({
      run,
      session,
      steps,
      task: userPrompt,
      model: definition.config.model,
      timeoutMs,
      onStatusChange: async (updatedRun) => {
        this.stopOrphanMonitor(runId);
        this.activeRuns.delete(runId);
        await this.handleRunComplete(updatedRun, session);
      },
    }).catch(async (err) => {
      logVerbose(`[agents/manager] Chain run ${runId} error: ${err}`);
      this.stopOrphanMonitor(runId);
      this.activeRuns.delete(runId);
      run.status = "failed";
      run.ended = run.ended ?? new Date().toISOString();
      run.error = run.error ?? `Chain run error: ${err}`;
      run.pid = undefined;
      try {
        await saveRunStatus(session, run);
        await this.handleRunComplete(run, session);
      } catch (finalizeErr) {
        logVerbose(`[agents/manager] Failed to finalize chain run ${runId}: ${finalizeErr}`);
      }
    });

    return run;
  }

  /**
   * Handle a run completing (success, failure, timeout).
   */
  private async handleRunComplete(
    run: AgentRun,
    session: string,
  ): Promise<void> {
    const statusEmoji =
      run.status === "completed"
        ? "✅"
        : run.status === "stopped"
          ? "🛑"
          : run.status === "timeout"
            ? "⏱️"
            : "❌";
    const stepInfo = run.steps
      ? ` (${run.steps.results.filter((s) => s.status === "completed").length}/${run.steps.total} steps)`
      : "";

    const statusMessage = `${statusEmoji} Agent ${run.status}: ${run.id}${stepInfo}${run.error ? `\n${run.error}` : ""}`;

    // Read the output tail before archiveRun moves the run directory
    let delivered = false;
    if (this.config.onRunComplete) {
      const output = await readOutput(session, run.id);
      const outputTail =
        output.length > 6000 ? `…${output.slice(-6000)}` : output;
      try {
        await this.config.onRunComplete(session, run, outputTail);
        delivered = true;
      } catch (err) {
        logVerbose(
          `[agents/manager] onRunComplete failed for ${run.id}, falling back to plain notification: ${err}`,
        );
      }
    }
    if (!delivered) {
      await this.config.sendNotification(session, statusMessage);
    }

    // Archive the completed run
    await archiveRun(session, run.id);

    // Unregister session if no more active runs
    await unregisterAgentSessionIfEmpty(session);

    logVerbose(`[agents/manager] Run ${run.status}: ${run.id}`);
  }

  /**
   * Stop a running agent.
   */
  async stopRun(runId: string): Promise<boolean> {
    // Check in-memory active runs first
    const active = this.activeRuns.get(runId);
    if (active) {
      const { run, session } = active;
      run.status = "stopped";
      await saveRunStatus(session, run);

      if (run.pid && isProcessAlive(run.pid)) {
        stopProcess(run.pid);
      }

      logVerbose(`[agents/manager] Stop requested for run: ${runId}`);
      return true;
    }

    // Try to find on disk (may have been started before restart)
    const found = await findRunById(runId);
    if (!found) return false;

    const { run, session } = found;
    if (run.pid && isProcessAlive(run.pid)) {
      stopProcess(run.pid);
      // Give SIGTERM/SIGKILL a brief chance to complete before finalizing.
      for (let i = 0; i < 30; i++) {
        if (!isProcessAlive(run.pid)) break;
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
    }
    run.status = "stopped";
    run.ended = new Date().toISOString();
    run.pid = undefined;
    await saveRunStatus(session, run);
    await this.handleRunComplete(run, session);
    logVerbose(`[agents/manager] Stopped run (from disk): ${runId}`);
    return true;
  }

  /**
   * Get run status.
   */
  async getRunStatus(runId: string): Promise<AgentRun | null> {
    const active = this.activeRuns.get(runId);
    if (active) return active.run;

    const found = await findRunById(runId);
    return found?.run ?? null;
  }

  /**
   * List all active runs.
   */
  async listActiveRuns(): Promise<AgentRun[]> {
    return listAllActiveRuns();
  }

  /**
   * List all available definitions.
   */
  async listDefinitions(): Promise<AgentDefinition[]> {
    const result = await discoverDefinitions(this.config.definitionsPath);
    return result.definitions;
  }

  /**
   * Resume active runs on startup.
   * Checks PIDs — marks dead processes as failed.
   */
  async resumeActiveRuns(): Promise<void> {
    const runs = await listAllActiveRuns();
    logVerbose(`[agents/manager] Resuming ${runs.length} active runs`);

    for (const run of runs) {
      const found = await findRunById(run.id);
      if (!found) continue;

      const { session } = found;

      if (run.pid) {
        if (isProcessAlive(run.pid)) {
          // Process is still alive — track it as orphaned-running
          // We can't re-attach stdio, but the process writes to output.log
          this.activeRuns.set(run.id, { run, session });
          registerAgentSession(session);
          this.startOrphanMonitor(run.id);
          logVerbose(
            `[agents/manager] Run ${run.id} still alive (PID ${run.pid}), tracking as orphaned-running`,
          );
        } else {
          // Process died during restart
          run.status = "failed";
          run.ended = new Date().toISOString();
          run.error = "Process died during restart";
          run.pid = undefined;
          await saveRunStatus(session, run);
          await archiveRun(session, run.id);
          await unregisterAgentSessionIfEmpty(session);
          logVerbose(
            `[agents/manager] Run ${run.id} PID dead, marked as failed`,
          );
        }
      } else {
        // No PID recorded — mark as failed
        run.status = "failed";
        run.ended = new Date().toISOString();
        run.error = "No PID recorded — process state unknown";
        run.pid = undefined;
        await saveRunStatus(session, run);
        await archiveRun(session, run.id);
        await unregisterAgentSessionIfEmpty(session);
        logVerbose(
          `[agents/manager] Run ${run.id} has no PID, marked as failed`,
        );
      }
    }
  }

  /**
   * Shutdown — stop tracking (processes continue running independently).
   */
  shutdown(): void {
    logVerbose(
      `[agents/manager] Shutting down, ${this.activeRuns.size} active runs`,
    );
    for (const runId of this.orphanMonitors.keys()) {
      this.stopOrphanMonitor(runId);
    }
    this.activeRuns.clear();
  }
}

// Singleton instance
let agentManager: AgentRunManager | null = null;

/**
 * Get the singleton AgentRunManager instance.
 */
export function getAgentManager(
  config?: AgentRunManagerConfig,
): AgentRunManager {
  if (!agentManager && config) {
    agentManager = new AgentRunManager(config);
  }
  if (!agentManager) {
    throw new Error("AgentRunManager not initialized");
  }
  return agentManager;
}

/**
 * Reset the singleton (for testing and reload).
 */
export function resetAgentManager(): void {
  if (agentManager) {
    agentManager.shutdown();
    agentManager = null;
  }
}
