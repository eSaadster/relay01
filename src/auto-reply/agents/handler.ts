// Agent command handler for Slack messages
// Handles commands like "agent run <task>", "agent status", "agent stop <id>", "agent list"

import { loadConfig } from "../../config/config.js";
import { logVerbose } from "../../globals.js";
import { getAgentManager } from "./manager.js";
import { listAllActiveRuns } from "./memory.js";
import type { AgentRun, AgentsConfig } from "./types.js";

// Helper to get agents config
function getAgentsConfig(): AgentsConfig & { definitionsPath: string } {
  const cfg = loadConfig();
  const agentsConfig = cfg.agents ?? {};
  return {
    ...agentsConfig,
    definitionsPath:
      agentsConfig.definitionsPath ?? "~/relay01/agents/definitions",
    maxConcurrent: agentsConfig.maxConcurrent ?? 3,
  };
}

export type AgentCommand =
  | { type: "list" }
  | { type: "status"; runId?: string }
  | { type: "run"; definitionId?: string; prompt: string }
  | { type: "stop"; runId: string }
  | { type: "answer"; runId: string; text: string }
  | { type: "steer"; runId: string; text: string };

/**
 * Check if a message is an agent command.
 */
export function isAgentCommand(text: string): boolean {
  return parseAgentCommand(text) !== null;
}

/**
 * Parse a message for agent commands.
 * Returns null if not an agent command.
 */
export function parseAgentCommand(text: string): AgentCommand | null {
  const trimmed = text.trim();
  const lower = trimmed.toLowerCase();

  // "agent" / "agent status" / "agent list" (bare)
  if (lower === "agent" || lower === "agent status") {
    return { type: "status" };
  }

  if (lower === "agent list" || lower === "agent definitions") {
    return { type: "list" };
  }

  // "agent stop <run-id>"
  if (lower.startsWith("agent stop")) {
    const rest = trimmed.slice("agent stop".length).trim();
    if (!rest) return null; // require a run ID
    return { type: "stop", runId: rest };
  }

  // "agent answer <run-id> <text>" / "agent steer <run-id> <text>"
  const interactMatch = trimmed.match(/^agent\s+(answer|steer)\s+(\S+)\s+(.+)$/is);
  if (interactMatch) {
    return {
      type: interactMatch[1].toLowerCase() as "answer" | "steer",
      runId: interactMatch[2],
      text: interactMatch[3].trim(),
    };
  }

  // "agent status <run-id>"
  if (lower.startsWith("agent status ")) {
    const runId = trimmed.slice("agent status ".length).trim();
    return { type: "status", runId: runId || undefined };
  }

  // "agent run -d <definition> <task>" or "agent run -a <definition> <task>"
  const defMatch = trimmed.match(/^agent\s+run\s+-(?:d|a)\s+(\S+)\s+(.+)$/i);
  if (defMatch) {
    return {
      type: "run",
      definitionId: defMatch[1],
      prompt: defMatch[2].trim(),
    };
  }

  // "agent run <definition> <task>" (definition is first word after "run")
  if (lower.startsWith("agent run ")) {
    const rest = trimmed.slice("agent run ".length).trim();
    if (!rest) return null;

    // Check if first word looks like a definition ID (no spaces, identifier-ish)
    const parts = rest.split(/\s+/);
    if (parts.length >= 2 && /^[a-z0-9_-]+$/i.test(parts[0])) {
      return {
        type: "run",
        definitionId: parts[0],
        prompt: parts.slice(1).join(" "),
      };
    }

    // Ad-hoc run (no definition)
    return { type: "run", prompt: rest };
  }

  return null;
}

/**
 * Format agent status for display.
 */
function formatAgentStatus(runs: AgentRun[]): string {
  const lines = runs.map((run) => {
    const age = Math.round(
      (Date.now() - new Date(run.started).getTime()) / 1000 / 60,
    );
    const prompt = run.userPrompt
      ? `"${run.userPrompt.slice(0, 40)}${run.userPrompt.length > 40 ? "..." : ""}"`
      : "";
    const stepInfo = run.steps
      ? ` [step ${run.steps.current + 1}/${run.steps.total}]`
      : "";

    return `• ${run.id} (${age}m${stepInfo})\n  ${prompt}`;
  });

  return `🤖 Active agents (${runs.length}):\n\n${lines.join("\n\n")}`;
}

/**
 * Handle an agent command and return a human-readable Slack response string.
 */
export async function handleAgentCommand(
  cmd: AgentCommand,
  sessionName: string,
  sendNotification: (msg: string) => Promise<void>,
): Promise<string> {
  const agentsConfig = getAgentsConfig();
  const { definitionsPath } = agentsConfig;

  logVerbose(
    `[agent-handler] Handling ${cmd.type} for session ${sessionName}`,
  );

  try {
    switch (cmd.type) {
      case "status": {
        if (cmd.runId) {
          const manager = getAgentManager({
            definitionsPath,
            maxConcurrent: agentsConfig.maxConcurrent ?? 3,
            sendNotification: async (_, msg) => sendNotification(msg),
          });
          const run = await manager.getRunStatus(cmd.runId);
          if (!run) {
            return `Run not found: ${cmd.runId}`;
          }
          const age = Math.round(
            (Date.now() - new Date(run.started).getTime()) / 1000 / 60,
          );
          const stepInfo = run.steps
            ? ` [step ${run.steps.current + 1}/${run.steps.total}]`
            : "";
          return `*${run.id}* — ${run.status}${stepInfo}\nStarted: ${age}m ago\nPrompt: "${run.userPrompt.slice(0, 80)}${run.userPrompt.length > 80 ? "..." : ""}"${run.error ? `\nError: ${run.error}` : ""}`;
        }

        const runs = await listAllActiveRuns();
        if (runs.length === 0) {
          return "No active agents.";
        }
        return formatAgentStatus(runs);
      }

      case "list": {
        const manager = getAgentManager({
          definitionsPath,
          maxConcurrent: agentsConfig.maxConcurrent ?? 3,
          sendNotification: async (_, msg) => sendNotification(msg),
        });
        const definitions = await manager.listDefinitions();
        if (definitions.length === 0) {
          return "No agent definitions found.";
        }
        const lines = definitions.map(
          (d) =>
            `• ${d.id} (timeout: ${d.config.timeout || "30m"}${d.isChain ? ", chain" : ""})`,
        );
        return `📋 Agent definitions:\n${lines.join("\n")}`;
      }

      case "stop": {
        const runs = await listAllActiveRuns();

        if (runs.length === 0) {
          return "No active agents to stop.";
        }

        const runToStop = runs.find(
          (r) => r.id === cmd.runId || r.id.startsWith(cmd.runId),
        );

        if (!runToStop) {
          return `Agent not found: ${cmd.runId}\n\nActive agents:\n${runs.map((r) => `• ${r.id}`).join("\n")}`;
        }

        const manager = getAgentManager({
          definitionsPath,
          maxConcurrent: agentsConfig.maxConcurrent ?? 3,
          sendNotification: async (_, msg) => sendNotification(msg),
        });

        const stopped = await manager.stopRun(runToStop.id);
        return stopped
          ? `🛑 Stopped agent: ${runToStop.id}`
          : `Failed to stop agent: ${runToStop.id}`;
      }

      case "answer":
      case "steer": {
        const manager = getAgentManager({
          definitionsPath,
          maxConcurrent: agentsConfig.maxConcurrent ?? 3,
          sendNotification: async (_, msg) => sendNotification(msg),
        });
        const ok =
          cmd.type === "answer"
            ? await manager.answerRun(cmd.runId, cmd.text)
            : await manager.steerRun(cmd.runId, cmd.text);
        if (ok) {
          return cmd.type === "answer"
            ? `✉️ Answer delivered to ${cmd.runId}`
            : `➡️ Steering message queued for ${cmd.runId}`;
        }
        return cmd.type === "answer"
          ? `No pending question found for run ${cmd.runId} (run not active or not waiting for input).`
          : `Run ${cmd.runId} is not active — cannot steer.`;
      }

      case "run": {
        if (!cmd.prompt) {
          return "Usage: agent run <task description>";
        }

        const manager = getAgentManager({
          definitionsPath,
          maxConcurrent: agentsConfig.maxConcurrent ?? 3,
          sendNotification: async (_, msg) => sendNotification(msg),
        });

        const run = await manager.startRun({
          definitionId: cmd.definitionId,
          userPrompt: cmd.prompt,
          session: sessionName,
        });

        return `_Agent started: ${run.id}_`;
      }

      default:
        return "Unknown agent command.";
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logVerbose(`[agent-handler] Error: ${msg}`);
    return `Agent error: ${msg}`;
  }
}
