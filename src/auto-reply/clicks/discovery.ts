// Filesystem discovery for clicks.json files

import fs from "node:fs/promises";
import path from "node:path";

import { logVerbose } from "../../globals.js";
import { SLACK_BASE_PATH } from "../pi-agent-tools.js";
import { validateClicksFile } from "./schema.js";
import type { ClickContext, ClicksFile, DiscoveredClicks } from "./types.js";

const CLICKS_FILE = "clicks.json";

/**
 * Check if a file exists.
 */
async function fileExists(filePath: string): Promise<boolean> {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

/**
 * Load and validate a clicks.json file.
 */
async function loadClicksFile(
  filePath: string
): Promise<ClicksFile | null> {
  try {
    const content = await fs.readFile(filePath, "utf8");
    const data = JSON.parse(content);
    const result = validateClicksFile(data);

    if (!result.success) {
      console.warn(`[clicks] Invalid clicks.json at ${filePath}:`);
      for (const error of result.errors || []) {
        console.warn(`  - ${error}`);
      }
      return null;
    }

    return result.data!;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
      console.warn(`[clicks] Error loading ${filePath}: ${err}`);
    }
    return null;
  }
}

/**
 * Create a ClickContext for a session or project.
 */
function createContext(
  sessionName: string,
  clicksFilePath: string,
  alertTarget: string,
  isProjectLevel: boolean
): ClickContext {
  const sessionPath = isProjectLevel
    ? SLACK_BASE_PATH
    : path.join(SLACK_BASE_PATH, sessionName);

  return {
    sessionName,
    clicksFilePath,
    scratchpadPath: path.join(sessionPath, "scratchpad", "clicks"),
    alertTarget,
    isProjectLevel,
  };
}

/**
 * Discover all clicks.json files in the workspace.
 * Scans project-level and session-level (user/channel) clicks.json files.
 */
export async function discoverClicks(): Promise<DiscoveredClicks> {
  const result: DiscoveredClicks = {
    sessionClicks: [],
    projectClicks: null,
  };

  // 1. Check project-level clicks.json
  const projectClicksPath = path.join(SLACK_BASE_PATH, CLICKS_FILE);
  if (await fileExists(projectClicksPath)) {
    const config = await loadClicksFile(projectClicksPath);
    if (config) {
      if (!config.alertChannel) {
        console.warn(
          `[clicks] Project clicks.json missing alertChannel, skipping`
        );
      } else {
        const context = createContext(
          "project",
          projectClicksPath,
          config.alertChannel,
          true
        );
        result.projectClicks = { config, context };
        logVerbose(
          `Discovered ${config.clicks.length} project-level clicks (alert to ${config.alertChannel})`
        );
      }
    }
  }

  // 2. Scan session directories for clicks.json
  try {
    const entries = await fs.readdir(SLACK_BASE_PATH, { withFileTypes: true });

    for (const entry of entries) {
      if (!entry.isDirectory()) continue;

      // Only process @username and #channelname directories
      if (!entry.name.startsWith("@") && !entry.name.startsWith("#")) continue;

      const sessionClicksPath = path.join(
        SLACK_BASE_PATH,
        entry.name,
        CLICKS_FILE
      );

      if (await fileExists(sessionClicksPath)) {
        const config = await loadClicksFile(sessionClicksPath);
        if (config) {
          // Session clicks alert to the session itself
          const context = createContext(
            entry.name,
            sessionClicksPath,
            entry.name, // alertTarget is the session name
            false
          );

          result.sessionClicks.push({
            sessionName: entry.name,
            config,
            context,
          });

          logVerbose(
            `Discovered ${config.clicks.length} clicks for session ${entry.name}`
          );
        }
      }
    }
  } catch (err) {
    console.warn(`[clicks] Error scanning sessions: ${err}`);
  }

  const totalClicks =
    (result.projectClicks?.config.clicks.length || 0) +
    result.sessionClicks.reduce((sum, s) => sum + s.config.clicks.length, 0);

  logVerbose(
    `Click discovery complete: ${totalClicks} clicks across ${result.sessionClicks.length} sessions` +
      (result.projectClicks ? " + project" : "")
  );

  return result;
}

/**
 * Discover clicks for a specific session only.
 */
export async function discoverSessionClicks(
  sessionName: string
): Promise<{ config: ClicksFile; context: ClickContext } | null> {
  const clicksPath = path.join(SLACK_BASE_PATH, sessionName, CLICKS_FILE);

  if (!(await fileExists(clicksPath))) {
    return null;
  }

  const config = await loadClicksFile(clicksPath);
  if (!config) {
    return null;
  }

  const context = createContext(sessionName, clicksPath, sessionName, false);

  return { config, context };
}
