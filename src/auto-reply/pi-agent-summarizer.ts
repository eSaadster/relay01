// Session summarizer for pi-agent - uses pi-agent to create scratchpad content
import path from "node:path";

import { Agent } from "@earendil-works/pi-agent-core";
import { type Message, type TextContent } from "@earendil-works/pi-ai";
import { logVerbose } from "../globals.js";
import { createGetApiKey, findModel } from "./pi-agent.js";
import {
  type Scratchpad,
  parseScratchpad,
  extractRecentTurns,
} from "./pi-agent-scratchpad.js";

const MAX_MESSAGES_TO_SUMMARIZE = 150;
const SUMMARIZER_MODEL = "gpt-6-luna";

/**
 * Format messages for the summarizer prompt
 */
function formatMessagesForSummary(messages: Message[]): string {
  const lines: string[] = [];

  for (const msg of messages) {
    if (msg.role === "user") {
      const content = typeof msg.content === "string"
        ? msg.content
        : (msg.content as Array<{ type: string; text?: string }>)
            .filter((c) => c.type === "text")
            .map((c) => c.text || "")
            .join("\n");

      if (content.trim()) {
        lines.push(`U: ${content.trim()}`);
      }
    } else if (msg.role === "assistant") {
      const content = (msg.content as Array<{ type: string; text?: string }>)
        .filter((c) => c.type === "text")
        .map((c) => c.text || "")
        .join("\n");

      if (content.trim()) {
        lines.push(`A: ${content.trim()}`);
      }
    }
    // Skip toolResult messages for readability
  }

  return lines.join("\n\n");
}

/**
 * Build the summarizer prompt
 */
function buildSummarizerPrompt(
  messages: Message[],
  existingScratchpad: Scratchpad | null,
  options: { isDm?: boolean } = {},
): string {
  const existingCritical = existingScratchpad?.critical?.length
    ? existingScratchpad.critical.map((c) => `- ${c}`).join("\n")
    : "None";

  // Cap messages to prevent huge prompts
  const cappedMessages = messages.slice(-MAX_MESSAGES_TO_SUMMARIZE);
  const wasTruncated = messages.length > MAX_MESSAGES_TO_SUMMARIZE;

  const conversationText = formatMessagesForSummary(cappedMessages);

  return `You are summarizing a WhatsApp conversation session for future reference.

## Existing memory (preserve and merge):
${existingCritical}

## Recent conversation${wasTruncated ? " (truncated - older messages omitted)" : ""}:
${conversationText}

## Output format (Markdown):
## summary
- <key topic or decision>
- ...

## critical
- <important fact, preference, or action item>
- ...

## promote
- <fact that matters beyond this session>
- ...
${options.isDm ? `
## promote-user
- <durable fact about this user>
- ...
` : ""}
## Rules:
- summary: Main topics discussed, decisions made, problems solved (max 10 items)
- critical: User's personal details, explicit memory requests ("remember this"), preferences, action items (max 20 items)
- promote: Facts useful across ALL sessions of this assistant — team-wide decisions, dates/deadlines, infrastructure or process changes, explicit "everyone should know" requests (max 5 items). Be conservative: personal preferences, private details, and session-specific chatter do NOT belong here. Leave the section empty if nothing qualifies.
${options.isDm ? '- promote-user: Durable facts about the user themself — role, expertise, long-term preferences, ongoing projects (max 5 items). These persist even if the session history is cleared. Leave empty if nothing qualifies.\n' : ""}- MERGE existing critical items - preserve prior memories, deduplicate similar items
- If conversation was truncated, still capture ALL high-signal facts in critical
- Keep each bullet concise (1 line)
- Output ONLY the markdown sections, no preamble`;
}

/**
 * Parse the LLM response into structured data
 */
export function parseSummarizerResponse(response: string): {
  summary: string[];
  critical: string[];
  promote: string[];
  promoteUser: string[];
} {
  // Use the existing parseScratchpad function for summary and critical
  const parsed = parseScratchpad(response);

  // parseScratchpad doesn't know about promote sections — extract them here
  const promote: string[] = [];
  const promoteUser: string[] = [];
  for (const section of response.split(/^## /m)) {
    const lines = section.trim().split("\n");
    const header = lines[0]?.toLowerCase().trim();
    const target = header === "promote" ? promote : header === "promote-user" ? promoteUser : null;
    if (!target) continue;
    for (const line of lines.slice(1)) {
      if (line.startsWith("- ") && line.slice(2).trim()) {
        target.push(line.slice(2).trim());
      }
    }
  }

  return { summary: parsed.summary, critical: parsed.critical, promote, promoteUser };
}

/**
 * Call the summarizer using pi-agent (handles OAuth properly).
 * Exported so other host-side LLM passes (e.g. memory consolidation)
 * can reuse the same cheap-model path.
 */
export async function callSummarizerWithAgent(prompt: string): Promise<string> {
  const agent = new Agent({ getApiKey: createGetApiKey() });

  // Set model using the configured custom provider.
  const found = await findModel(SUMMARIZER_MODEL);
  if (!found) throw new Error(`Summarizer model ${SUMMARIZER_MODEL} not found`);
  agent.state.model = found.model;

  // Set system prompt for summarization
  agent.state.systemPrompt = "You are a helpful assistant that summarizes conversations. Output only the requested format, no preamble.";

  // Disable thinking for faster response
  agent.state.thinkingLevel = "off";

  try {
    // Send the prompt
    await agent.prompt(prompt);
    await agent.waitForIdle();

    // Extract response text
    const messages = agent.state.messages;
    const lastMsg = messages[messages.length - 1];
    if (lastMsg && "content" in lastMsg && Array.isArray(lastMsg.content)) {
      const text = lastMsg.content
        .filter((c): c is TextContent => c.type === "text")
        .map((c) => c.text)
        .join("\n");
      return text;
    }

    throw new Error("No response from summarizer agent");
  } finally {
    agent.abort();
  }
}

export interface SummarizeResult {
  summary: string[];
  critical: string[];
  promote: string[];
  promoteUser: string[];
  recentTurns: Array<{ role: "user" | "assistant"; content: string }>;
}

/**
 * Summarize a session's messages into scratchpad content
 * - Caps input at ~150 messages
 * - Feeds existing critical into prompt for model to merge/dedupe
 * - Model outputs complete new scratchpad content
 * - Extracts recent turns separately (not via LLM)
 */
export async function summarizeSession(
  messages: Message[],
  existingScratchpad: Scratchpad | null,
  options: { isDm?: boolean } = {}
): Promise<SummarizeResult> {
  logVerbose(`Summarizing session with ${messages.length} messages`);

  // Extract recent turns before summarization (this is deterministic, not LLM)
  const recentTurns = extractRecentTurns(messages);

  // If very few messages, don't bother with LLM summarization
  if (messages.length < 3) {
    logVerbose("Too few messages to summarize, keeping existing scratchpad");
    return {
      summary: existingScratchpad?.summary ?? [],
      critical: existingScratchpad?.critical ?? [],
      promote: [],
      promoteUser: [],
      recentTurns,
    };
  }

  // Build prompt and call LLM using pi-agent
  const prompt = buildSummarizerPrompt(messages, existingScratchpad, options);
  const response = await callSummarizerWithAgent(prompt);

  // Parse the response
  const { summary, critical, promote, promoteUser } = parseSummarizerResponse(response);

  logVerbose(`Summarization complete: ${summary.length} summary items, ${critical.length} critical items, ${promote.length} promoted facts, ${promoteUser.length} user facts`);

  // Guard against wiping existing data with empty results (e.g., API failure)
  const existingHasData = (existingScratchpad?.critical?.length ?? 0) > 0 || (existingScratchpad?.summary?.length ?? 0) > 0;
  const newIsEmpty = summary.length === 0 && critical.length === 0;

  if (newIsEmpty && existingHasData) {
    logVerbose("WARNING: Summarization returned empty but existing data exists - preserving existing scratchpad");
    return {
      summary: existingScratchpad?.summary ?? [],
      critical: existingScratchpad?.critical ?? [],
      promote: [],
      promoteUser: [],
      recentTurns,
    };
  }

  return {
    summary,
    critical,
    promote,
    promoteUser,
    recentTurns,
  };
}
