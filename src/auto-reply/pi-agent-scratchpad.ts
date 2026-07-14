// Scratchpad persistence for pi-agent sessions
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";

import type { Message, UserMessage, AssistantMessage, TextContent } from "@earendil-works/pi-ai";
import { logVerbose } from "../globals.js";

// Base path: ~/relay01/slack/
export const SLACK_BASE = path.join(os.homedir(), "relay01", "slack");

export interface Scratchpad {
  summary: string[];
  critical: string[];
  recentTurns: Array<{ role: "user" | "assistant"; content: string }>;
}

/**
 * Ensure the scratchpad directory exists for a session (mkdirp)
 * sessionName should be @username or #channelname
 * Path: ~/relay01/slack/{sessionName}/scratchpad/
 */
export async function ensureSessionDir(sessionName: string): Promise<string> {
  const sessionDir = path.join(SLACK_BASE, sessionName, "scratchpad");
  await fs.mkdir(sessionDir, { recursive: true });
  return sessionDir;
}

/**
 * Get the file path for a session's scratchpad
 * sessionName should be @username or #channelname
 * Path: ~/relay01/slack/{sessionName}/scratchpad/session.md
 */
function getScratchpadPath(sessionName: string): string {
  return path.join(SLACK_BASE, sessionName, "scratchpad", "session.md");
}

/**
 * Parse a markdown scratchpad into structured data
 */
export function parseScratchpad(content: string): Scratchpad {
  const result: Scratchpad = {
    summary: [],
    critical: [],
    recentTurns: [],
  };

  // Split by ## headers
  const sections = content.split(/^## /m);

  for (const section of sections) {
    const lines = section.trim().split("\n");
    const header = lines[0]?.toLowerCase().trim();
    const body = lines.slice(1).join("\n").trim();

    if (header === "summary") {
      result.summary = body
        .split("\n")
        .filter((line) => line.startsWith("- "))
        .map((line) => line.slice(2).trim());
    } else if (header === "critical") {
      result.critical = body
        .split("\n")
        .filter((line) => line.startsWith("- "))
        .map((line) => line.slice(2).trim());
    } else if (header === "recent") {
      // Parse U:/A: pairs
      const turns: Scratchpad["recentTurns"] = [];
      let currentRole: "user" | "assistant" | null = null;
      let currentContent: string[] = [];

      const flushTurn = () => {
        if (currentRole && currentContent.length > 0) {
          turns.push({
            role: currentRole,
            content: currentContent.join("\n").trim(),
          });
        }
        currentContent = [];
      };

      for (const line of body.split("\n")) {
        if (line.startsWith("U: ")) {
          flushTurn();
          currentRole = "user";
          currentContent.push(line.slice(3));
        } else if (line.startsWith("A: ")) {
          flushTurn();
          currentRole = "assistant";
          currentContent.push(line.slice(3));
        } else if (currentRole && line.trim()) {
          // Continuation of previous turn
          currentContent.push(line);
        }
      }
      flushTurn();

      result.recentTurns = turns;
    }
  }

  return result;
}

/**
 * Format scratchpad data into markdown
 */
export function formatScratchpad(data: Scratchpad, senderId?: string): string {
  const lines: string[] = [];

  if (senderId) {
    lines.push(`# Session Memory for ${senderId}`);
    lines.push("");
  }

  lines.push("## summary");
  for (const item of data.summary) {
    lines.push(`- ${item}`);
  }
  lines.push("");

  lines.push("## critical");
  for (const item of data.critical) {
    lines.push(`- ${item}`);
  }
  lines.push("");

  lines.push("## recent");
  for (const turn of data.recentTurns) {
    const prefix = turn.role === "user" ? "U:" : "A:";
    // Handle multi-line content
    const contentLines = turn.content.split("\n");
    lines.push(`${prefix} ${contentLines[0]}`);
    for (let i = 1; i < contentLines.length; i++) {
      lines.push(contentLines[i]);
    }
    lines.push("");
  }

  return lines.join("\n");
}

/**
 * Load and parse scratchpad for a session
 * sessionName should be @username or #channelname
 * Returns null if file doesn't exist or parse fails (logs warning)
 */
export async function loadScratchpad(sessionName: string): Promise<Scratchpad | null> {
  const filePath = getScratchpadPath(sessionName);

  try {
    const content = await fs.readFile(filePath, "utf-8");
    const scratchpad = parseScratchpad(content);
    logVerbose(`Loaded scratchpad for ${sessionName}: ${scratchpad.critical.length} critical, ${scratchpad.recentTurns.length} recent turns`);
    return scratchpad;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      logVerbose(`No scratchpad found for ${sessionName}`);
      return null;
    }
    console.warn(`[pi-agent] WARNING: Failed to load scratchpad for ${sessionName}: ${err}`);
    return null;
  }
}

/**
 * Save scratchpad atomically (write to .tmp, then rename)
 * sessionName should be @username or #channelname
 */
export async function saveScratchpad(sessionName: string, data: Scratchpad): Promise<void> {
  await ensureSessionDir(sessionName);

  const filePath = getScratchpadPath(sessionName);
  const tmpPath = `${filePath}.tmp`;

  const content = formatScratchpad(data, sessionName);

  await fs.writeFile(tmpPath, content, "utf-8");
  await fs.rename(tmpPath, filePath);

  logVerbose(`Saved scratchpad for ${sessionName}: ${data.critical.length} critical, ${data.recentTurns.length} recent turns`);
}

/**
 * Extract last 3-4 user/assistant turn pairs from message array
 */
export function extractRecentTurns(messages: Message[]): Scratchpad["recentTurns"] {
  const turns: Scratchpad["recentTurns"] = [];
  const maxTurns = 4; // 4 pairs = 8 messages max

  // Work backwards through messages to find user/assistant pairs
  for (let i = messages.length - 1; i >= 0 && turns.length < maxTurns * 2; i--) {
    const msg = messages[i];

    if (msg.role === "user") {
      const content = typeof msg.content === "string"
        ? msg.content
        : (msg.content as Array<{ type: string; text?: string }>)
            .filter((c) => c.type === "text")
            .map((c) => c.text || "")
            .join("\n");

      if (content.trim()) {
        turns.unshift({ role: "user", content: content.trim() });
      }
    } else if (msg.role === "assistant") {
      const content = (msg.content as Array<{ type: string; text?: string }>)
        .filter((c) => c.type === "text")
        .map((c) => c.text || "")
        .join("\n");

      if (content.trim()) {
        turns.unshift({ role: "assistant", content: content.trim() });
      }
    }
    // Skip toolResult messages
  }

  // Trim to last 3-4 complete pairs (user followed by assistant)
  // Find pairs and keep last 3-4
  const pairs: Array<{ user: string; assistant: string }> = [];
  for (let i = 0; i < turns.length - 1; i++) {
    if (turns[i].role === "user" && turns[i + 1]?.role === "assistant") {
      pairs.push({ user: turns[i].content, assistant: turns[i + 1].content });
      i++; // Skip the assistant we just paired
    }
  }

  // Take last 3-4 pairs
  const recentPairs = pairs.slice(-4);

  // Flatten back to turns
  const result: Scratchpad["recentTurns"] = [];
  for (const pair of recentPairs) {
    result.push({ role: "user", content: pair.user });
    result.push({ role: "assistant", content: pair.assistant });
  }

  return result;
}
