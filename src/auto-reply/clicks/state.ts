// Click state persistence

import fs from "node:fs/promises";
import path from "node:path";

import { logVerbose } from "../../globals.js";
import { validateClicksStateFile } from "./schema.js";
import type {
  ClickContext,
  ClickResult,
  ClickState,
  ClicksStateFile,
} from "./types.js";

const STATE_FILE = ".state.json";

/**
 * Ensure the clicks scratchpad directory exists.
 */
async function ensureClicksDir(ctx: ClickContext): Promise<void> {
  await fs.mkdir(ctx.scratchpadPath, { recursive: true });
}

/**
 * Load all click states for a context.
 */
export async function loadClicksState(
  ctx: ClickContext
): Promise<ClicksStateFile> {
  const statePath = path.join(ctx.scratchpadPath, STATE_FILE);

  try {
    const content = await fs.readFile(statePath, "utf8");
    const data = JSON.parse(content);
    const result = validateClicksStateFile(data);

    if (!result.success) {
      logVerbose(`Invalid state file at ${statePath}, starting fresh`);
      return {};
    }

    return result.data!;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
      logVerbose(`Error loading state from ${statePath}: ${err}`);
    }
    return {};
  }
}

/**
 * Load state for a specific click.
 */
export async function loadClickState(
  ctx: ClickContext,
  clickId: string
): Promise<ClickState | null> {
  const allStates = await loadClicksState(ctx);
  return allStates[clickId] || null;
}

/**
 * Save state for a specific click.
 */
export async function saveClickState(
  ctx: ClickContext,
  state: ClickState
): Promise<void> {
  await ensureClicksDir(ctx);

  const statePath = path.join(ctx.scratchpadPath, STATE_FILE);
  const allStates = await loadClicksState(ctx);

  allStates[state.clickId] = state;

  await fs.writeFile(statePath, JSON.stringify(allStates, null, 2));
  logVerbose(`Saved state for click ${state.clickId}`);
}

/**
 * Save execution result to a markdown file for inspection.
 */
export async function saveClickResult(
  ctx: ClickContext,
  clickId: string,
  clickName: string,
  result: ClickResult
): Promise<void> {
  await ensureClicksDir(ctx);

  const resultPath = path.join(ctx.scratchpadPath, `${clickId}.md`);

  // Try to read existing log entries
  let existingLog = "";
  try {
    const existing = await fs.readFile(resultPath, "utf8");
    // Extract just the execution log section
    const logMatch = existing.match(/## Execution Log\n([\s\S]*?)$/);
    if (logMatch) {
      existingLog = logMatch[1].trim();
    }
  } catch {
    // File doesn't exist yet
  }

  // Build new log entry
  const timestamp = new Date(result.timestamp).toISOString();
  const status = result.error ? "ERROR" : result.shouldAlert ? "ALERT" : "OK";
  const newLogEntry = `- ${timestamp}: ${status} - ${result.summary.slice(0, 100)}`;

  // Keep last 20 log entries
  const logLines = existingLog
    .split("\n")
    .filter((l) => l.startsWith("- "))
    .slice(-19);
  logLines.push(newLogEntry);

  const content = `# Click: ${clickName}
Last Run: ${timestamp}
Status: ${status}
Alert Sent: ${result.shouldAlert}
Duration: ${result.durationMs}ms

## Last Execution Summary
${result.summary}

## Details
${result.details}

${result.error ? `## Error\n${result.error}\n\n` : ""}## Execution Log
${logLines.join("\n")}
`;

  await fs.writeFile(resultPath, content);
  logVerbose(`Saved result for click ${clickId} to ${resultPath}`);
}

/**
 * Update state after a successful execution.
 */
export async function updateStateAfterRun(
  ctx: ClickContext,
  clickId: string,
  result: ClickResult
): Promise<void> {
  const existingState = await loadClickState(ctx, clickId);

  const newState: ClickState = {
    clickId,
    lastRunTime: result.timestamp,
    lastResult: result.error ? "ERROR" : result.shouldAlert ? "ALERT" : "OK",
    lastSummary: result.summary,
    lastAlertTime: result.shouldAlert
      ? result.timestamp
      : existingState?.lastAlertTime,
    consecutiveFailures: result.error
      ? (existingState?.consecutiveFailures || 0) + 1
      : 0,
  };

  await saveClickState(ctx, newState);
}
