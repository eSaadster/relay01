// Click execution via pi-agent

import {
  Agent,
} from "@earendil-works/pi-agent-core";
import { getModel, type TextContent } from "@earendil-works/pi-ai";

import { logVerbose } from "../../globals.js";
import { loadSessionEnv } from "../../index.js";
import { createGetApiKey, findModel } from "../pi-agent.js";
import { createTools, SLACK_BASE_PATH } from "../pi-agent-tools.js";
import { discoverConventionSkills, getSkillRegistry } from "../skills/index.js";
import { loadClickState, saveClickResult, updateStateAfterRun } from "./state.js";
import type { ClickConfig, ClickContext, ClickResult } from "./types.js";

const CLICK_TIMEOUT_MS = 300000; // 5 minutes
const DEFAULT_MODEL = "claude-sonnet-4-6";

function shouldAlwaysAlert(click: ClickConfig): boolean {
  return click.alertCriteria?.trim().toUpperCase() === "ALWAYS";
}

/**
 * Build the prompt for a click execution.
 */
function buildClickPrompt(click: ClickConfig, lastRunTime?: number): string {
  let prompt = `## Click Execution: ${click.name}\n\n`;

  // Add deduplication context if we have a previous run time
  if (lastRunTime) {
    const lastRunDate = new Date(lastRunTime).toISOString();
    const oldestTimestamp = Math.floor(lastRunTime / 1000); // Slack uses seconds
    prompt += `**IMPORTANT - Deduplication:**\n`;
    prompt += `Last execution: ${lastRunDate}\n`;
    prompt += `When fetching Slack messages, you MUST use the \`oldest\` parameter set to \`${oldestTimestamp}\` to only fetch messages AFTER the last run.\n`;
    prompt += `This prevents re-processing the same messages multiple times.\n`;
    prompt += `Example: SLACK_FETCH_CONVERSATION_HISTORY with oldest: "${oldestTimestamp}"\n\n`;
  }

  prompt += `**Instructions:**\n${click.instructions}\n\n`;

  if (click.alertCriteria) {
    prompt += `**Alert Criteria:**\n${click.alertCriteria}\n\n`;
  } else {
    prompt += `**Alert Criteria:**\nUse your judgment to decide if this warrants alerting the user. Only alert for important, actionable findings.\n\n`;
  }

  const alertInstruction = shouldAlwaysAlert(click)
    ? "- Set shouldAlert to true (alert criteria is ALWAYS)\n"
    : "- Set shouldAlert to true ONLY if the alert criteria are met\n";

  prompt += `After executing, you MUST respond with a JSON block in this exact format:
\`\`\`json
{
  "shouldAlert": true or false,
  "summary": "Brief one-line summary of findings",
  "details": "Detailed findings and observations"
}
\`\`\`

Important:
${alertInstruction}- Keep summary to one headline line
- Put the full formatted briefing (all sections, issue IDs, assignees) in the details field
`;

  return prompt;
}

/**
 * Extract the assistant response text from the current agent turn.
 */
function extractAssistantResponse(agent: Agent): {
  responseText: string;
  error?: string;
} {
  const messages = agent.state.messages;

  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i];
    if ("role" in msg && msg.role === "user") break;

    if ("stopReason" in msg && msg.stopReason === "error") {
      const errorMessage =
        ("errorMessage" in msg && typeof msg.errorMessage === "string"
          ? msg.errorMessage
          : undefined) || "Agent returned an error with no message";
      return { responseText: "", error: errorMessage };
    }

    if ("content" in msg && Array.isArray(msg.content)) {
      const texts = msg.content
        .filter((c): c is TextContent => c.type === "text")
        .map((c) => c.text)
        .filter((t) => t.trim().length > 0);
      if (texts.length > 0) {
        return { responseText: texts.join("\n") };
      }
    }
  }

  return { responseText: "" };
}

/**
 * Parse the agent's response to extract click result.
 */
function parseClickResponse(
  responseText: string,
  click: ClickConfig
): {
  shouldAlert: boolean;
  summary: string;
  details: string;
} {
  // Try to extract JSON block
  const jsonMatch = responseText.match(/```json\s*([\s\S]*?)\s*```/);

  if (jsonMatch) {
    try {
      const parsed = JSON.parse(jsonMatch[1]);
      const result = {
        shouldAlert: Boolean(parsed.shouldAlert),
        summary: String(parsed.summary || "No summary provided"),
        details: String(parsed.details || "No details provided"),
      };
      if (shouldAlwaysAlert(click)) {
        result.shouldAlert = true;
      }
      return result;
    } catch {
      // JSON parse failed, fall through
    }
  }

  // Try to find raw JSON
  const rawJsonMatch = responseText.match(
    /\{[\s\S]*"shouldAlert"[\s\S]*"summary"[\s\S]*\}/
  );
  if (rawJsonMatch) {
    try {
      const parsed = JSON.parse(rawJsonMatch[0]);
      const result = {
        shouldAlert: Boolean(parsed.shouldAlert),
        summary: String(parsed.summary || "No summary provided"),
        details: String(parsed.details || "No details provided"),
      };
      if (shouldAlwaysAlert(click)) {
        result.shouldAlert = true;
      }
      return result;
    } catch {
      // JSON parse failed
    }
  }

  if (responseText.trim()) {
    const result = {
      shouldAlert: shouldAlwaysAlert(click),
      summary: shouldAlwaysAlert(click)
        ? "Click summary"
        : "Response missing structured JSON",
      details: responseText,
    };
    return result;
  }

  // Fallback: no usable response
  return {
    shouldAlert: false,
    summary: "Unable to parse structured response",
    details: responseText,
  };
}

/**
 * Execute a click using pi-agent.
 */
export async function executeClick(
  ctx: ClickContext,
  click: ClickConfig
): Promise<ClickResult> {
  const startTime = Date.now();

  // Determine effective session name for tools/env
  const effectiveSession = ctx.isProjectLevel ? "@project" : ctx.sessionName;

  // Load previous click state for deduplication
  const previousState = await loadClickState(ctx, click.id);
  const lastRunTime = previousState?.lastRunTime;

  // Load session env if not project-level
  if (!ctx.isProjectLevel) {
    loadSessionEnv(ctx.sessionName);
  }

  // Determine model - click config, session .env, global .env, or default
  const modelId = click.model || process.env.PI_AGENT_MODEL || DEFAULT_MODEL;

  try {
    // Create agent
    const agent = new Agent({ getApiKey: createGetApiKey() });

    // Set model with auto provider detection
    const found = await findModel(modelId);
    if (found) {
      agent.state.model = found.model;
      console.log(
        `[clicks] Executing ${click.id} for ${ctx.sessionName} with model ${modelId} (provider: ${found.provider})`
      );
    } else {
      console.log(
        `[clicks] Model ${modelId} not found, using default for ${click.id}`
      );
      agent.state.model = getModel("anthropic", DEFAULT_MODEL as any);
    }

    // Build system prompt for click execution
    let systemPrompt = `You are executing a scheduled click (automated task).
Your working directory: ~/relay01/slack/${effectiveSession}/scratchpad/

You have full network access via MCP tools and bash commands (curl, wget, etc.).
File operations are sandboxed to the scratchpad directory.

Execute the instructions precisely and report findings in the required JSON format.
Be concise and focus on the task at hand.
`;

    // Add skills to system prompt
    const conventionSkills = await discoverConventionSkills({
      workspacePath: SLACK_BASE_PATH,
      sessionName: effectiveSession,
    });

    if (conventionSkills.systemPromptSection) {
      systemPrompt += "\n\n" + conventionSkills.systemPromptSection;
    }

    const registry = getSkillRegistry();
    const programmaticPromptAdditions = registry.getSystemPromptAdditions();
    if (programmaticPromptAdditions) {
      systemPrompt += "\n\n" + programmaticPromptAdditions;
    }

    agent.state.systemPrompt = systemPrompt;
    agent.state.thinkingLevel = "off"; // Keep clicks fast

    // Set up tools
    const sessionTools = createTools(effectiveSession);
    const skillTools = registry.getAllTools();
    agent.state.tools = [...sessionTools, ...skillTools];

    // Build prompt and execute
    const prompt = buildClickPrompt(click, lastRunTime);

    // Execute with timeout
    const timeoutPromise = new Promise<never>((_, reject) => {
      setTimeout(() => reject(new Error("Click execution timeout")), CLICK_TIMEOUT_MS);
    });

    await Promise.race([agent.prompt(prompt), timeoutPromise]);
    await agent.waitForIdle();

    const { responseText, error } = extractAssistantResponse(agent);

    if (error) {
      throw new Error(error);
    }

    // Parse response
    const parsed = parseClickResponse(responseText, click);

    const result: ClickResult = {
      shouldAlert: parsed.shouldAlert,
      summary: parsed.summary,
      details: parsed.details,
      timestamp: Date.now(),
      durationMs: Date.now() - startTime,
    };

    // Save state and result
    await updateStateAfterRun(ctx, click.id, result);
    await saveClickResult(ctx, click.id, click.name, result);

    console.log(
      `[clicks] ${click.id} completed: ${result.shouldAlert ? "ALERT" : "OK"} (${result.durationMs}ms)`
    );

    return result;
  } catch (err) {
    const errorMessage = err instanceof Error ? err.message : String(err);

    const result: ClickResult = {
      shouldAlert: false,
      summary: `Execution failed: ${errorMessage}`,
      details: errorMessage,
      timestamp: Date.now(),
      durationMs: Date.now() - startTime,
      error: errorMessage,
    };

    // Save error state
    await updateStateAfterRun(ctx, click.id, result);
    await saveClickResult(ctx, click.id, click.name, result);

    console.error(`[clicks] ${click.id} failed: ${errorMessage}`);

    return result;
  }
}
