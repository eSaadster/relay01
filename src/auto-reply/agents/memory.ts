// Memory management for agents — status.json, events.jsonl, output.log

import * as fs from "node:fs/promises";
import os from "node:os";
import * as path from "node:path";
import { logVerbose } from "../../globals.js";
import type { AgentRun, AgentRunEvent } from "./types.js";

const STATUS_FILE = "status.json";
const EVENTS_FILE = "events.jsonl";
const OUTPUT_FILE = "output.log";
const SLACK_BASE = path.join(os.homedir(), "relay01", "slack");

// In-memory registry of sessions that have active agent runs (fast path optimization)
const activeAgentSessions = new Set<string>();
let registryInitialized = false;

/**
 * Initialize the agent session registry by scanning disk once on startup.
 */
export async function initializeAgentRegistry(): Promise<void> {
  if (registryInitialized) return;

  const sessions = await listSessionsWithAgents();
  for (const session of sessions) {
    const runs = await listActiveRuns(session);
    if (runs.length > 0) {
      activeAgentSessions.add(session);
    }
  }
  registryInitialized = true;
  logVerbose(
    `[agents/memory] Registry initialized: ${activeAgentSessions.size} sessions with active agents`,
  );
}

/**
 * Register a session as having active agents.
 */
export function registerAgentSession(session: string): void {
  activeAgentSessions.add(session);
  logVerbose(
    `[agents/memory] Registered session: ${session} (${activeAgentSessions.size} total)`,
  );
}

/**
 * Unregister a session (call after agent completes).
 * Only removes if the session has no more active runs.
 */
export async function unregisterAgentSessionIfEmpty(
  session: string,
): Promise<void> {
  const runs = await listActiveRuns(session);
  if (runs.length === 0) {
    activeAgentSessions.delete(session);
    logVerbose(
      `[agents/memory] Unregistered session: ${session} (${activeAgentSessions.size} total)`,
    );
  }
}

/**
 * Check if any sessions have active agents (fast path).
 */
export function hasAnyActiveAgents(): boolean {
  return activeAgentSessions.size > 0;
}

/**
 * Check if a specific session has active agents registered.
 */
export function sessionHasActiveAgents(session: string): boolean {
  return activeAgentSessions.has(session);
}

/**
 * Get the base path for Slack sessions.
 */
export function getSlackBasePath(): string {
  return SLACK_BASE;
}

/**
 * Get the run directory path.
 */
function getRunPath(session: string, runId: string): string {
  return path.join(SLACK_BASE, session, "agents", "runs", runId);
}

/**
 * Initialize run directory and files for a new agent run.
 */
export async function initializeRunDirectory(
  session: string,
  run: AgentRun,
): Promise<string> {
  const runPath = getRunPath(session, run.id);
  await fs.mkdir(runPath, { recursive: true });

  // Create artifacts subdirectory
  await fs.mkdir(path.join(runPath, "artifacts"), { recursive: true });

  // Initialize status.json
  await saveRunStatus(session, run);

  // Initialize empty events.jsonl
  await fs.writeFile(path.join(runPath, EVENTS_FILE), "");

  // Initialize empty output.log
  await fs.writeFile(path.join(runPath, OUTPUT_FILE), "");

  logVerbose(`[agents/memory] Initialized run directory at ${runPath}`);
  return runPath;
}

/**
 * Save run status to status.json.
 */
export async function saveRunStatus(
  session: string,
  run: AgentRun,
): Promise<void> {
  const runPath = getRunPath(session, run.id);
  const statusPath = path.join(runPath, STATUS_FILE);
  await fs.writeFile(statusPath, JSON.stringify(run, null, 2));
}

/**
 * Load run status from status.json.
 */
export async function loadRunStatus(
  session: string,
  runId: string,
): Promise<AgentRun | null> {
  const runPath = getRunPath(session, runId);
  const statusPath = path.join(runPath, STATUS_FILE);
  try {
    const content = await fs.readFile(statusPath, "utf-8");
    const parsed = JSON.parse(content) as AgentRun;
    if (!parsed.version) {
      logVerbose(
        `[agents/memory] Warning: status.json missing version for ${runId}`,
      );
    }
    return parsed;
  } catch {
    return null;
  }
}

/**
 * Load run status from an absolute path to a status.json directory.
 */
export async function loadRunStatusFromPath(
  runPath: string,
): Promise<AgentRun | null> {
  const statusPath = path.join(runPath, STATUS_FILE);
  try {
    const content = await fs.readFile(statusPath, "utf-8");
    return JSON.parse(content) as AgentRun;
  } catch {
    return null;
  }
}

/**
 * Append an event to events.jsonl.
 */
export async function appendEvent(
  session: string,
  runId: string,
  event: AgentRunEvent,
): Promise<void> {
  const runPath = getRunPath(session, runId);
  const eventsPath = path.join(runPath, EVENTS_FILE);
  const line = `${JSON.stringify(event)}\n`;
  await fs.appendFile(eventsPath, line);
}

/**
 * Read all events from events.jsonl.
 */
export async function readEvents(
  session: string,
  runId: string,
): Promise<AgentRunEvent[]> {
  const runPath = getRunPath(session, runId);
  const eventsPath = path.join(runPath, EVENTS_FILE);
  try {
    const content = await fs.readFile(eventsPath, "utf-8");
    return content
      .split("\n")
      .filter((line) => line.trim())
      .map((line) => JSON.parse(line) as AgentRunEvent);
  } catch {
    return [];
  }
}

/**
 * Read output.log content.
 */
export async function readOutput(
  session: string,
  runId: string,
): Promise<string> {
  const runPath = getRunPath(session, runId);
  const outputPath = path.join(runPath, OUTPUT_FILE);
  try {
    return await fs.readFile(outputPath, "utf-8");
  } catch {
    return "";
  }
}

/**
 * Get the output.log path for a run (for piping stdout).
 */
export function getOutputPath(session: string, runId: string): string {
  return path.join(getRunPath(session, runId), OUTPUT_FILE);
}

/**
 * Archive a completed run (move to archive folder).
 */
export async function archiveRun(
  session: string,
  runId: string,
): Promise<void> {
  const runPath = getRunPath(session, runId);
  const archiveDir = path.join(
    SLACK_BASE,
    session,
    "agents",
    "archive",
    runId,
  );

  try {
    await fs.mkdir(path.dirname(archiveDir), { recursive: true });
    await fs.rename(runPath, archiveDir);
    logVerbose(`[agents/memory] Archived run to ${archiveDir}`);
  } catch (err) {
    logVerbose(`[agents/memory] Failed to archive run: ${err}`);
  }
}

/**
 * List active runs for a specific session.
 * Returns runs with status "running".
 */
export async function listActiveRuns(session: string): Promise<AgentRun[]> {
  const runsDir = path.join(SLACK_BASE, session, "agents", "runs");
  try {
    const entries = await fs.readdir(runsDir, { withFileTypes: true });
    const runs: AgentRun[] = [];

    for (const entry of entries) {
      if (entry.isDirectory()) {
        const run = await loadRunStatusFromPath(
          path.join(runsDir, entry.name),
        );
        if (run && run.status === "running") {
          runs.push(run);
        }
      }
    }

    return runs;
  } catch {
    return [];
  }
}

/**
 * List all active runs across all sessions.
 */
export async function listAllActiveRuns(): Promise<AgentRun[]> {
  const sessions = await listSessionsWithAgents();
  const allRuns: AgentRun[] = [];

  for (const session of sessions) {
    const runs = await listActiveRuns(session);
    allRuns.push(...runs);
  }

  return allRuns;
}

/**
 * Find a run by ID across all sessions.
 * Returns { run, session } if found, null otherwise.
 */
export async function findRunById(
  runId: string,
): Promise<{ run: AgentRun; session: string } | null> {
  const sessions = await listSessionsWithAgents();

  for (const session of sessions) {
    const run = await loadRunStatus(session, runId);
    if (run) {
      return { run, session };
    }
  }

  return null;
}

/**
 * List all Slack sessions that have an agents/runs directory.
 */
async function listSessionsWithAgents(): Promise<string[]> {
  const sessions: string[] = [];
  try {
    const entries = await fs.readdir(SLACK_BASE, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.isDirectory()) {
        const runsPath = path.join(
          SLACK_BASE,
          entry.name,
          "agents",
          "runs",
        );
        try {
          await fs.access(runsPath);
          sessions.push(entry.name);
        } catch {
          // No agents/runs directory
        }
      }
    }
  } catch {
    // SLACK_BASE doesn't exist
  }
  return sessions;
}
