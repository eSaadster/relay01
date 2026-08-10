import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import {
  Agent,
  type AgentEvent,
} from "@earendil-works/pi-agent-core";
import { getModel, getProviders, getModels, type Message, type TextContent, type Model, type Api } from "@earendil-works/pi-ai";

import { logVerbose, isVerbose } from "../globals.js";
import { loadSessionEnv } from "../index.js";
import { createTools, createSessionContext, SLACK_BASE_PATH } from "./pi-agent-tools.js";
import {
  type Scratchpad,
  loadScratchpad,
  saveScratchpad,
} from "./pi-agent-scratchpad.js";
import { callSummarizerWithAgent, summarizeSession } from "./pi-agent-summarizer.js";
import {
  ensureGlobalMemoryFile,
  formatGlobalMemoryBlock,
  formatUserMemoryBlock,
  loadGlobalMemory,
  loadUserMemory,
  maybeConsolidateGlobalMemory,
  maybeConsolidateUserMemory,
  proposeGlobalFacts,
  proposeUserFacts,
  recordUserIdentity,
} from "./memory-store.js";
import { discoverConventionSkills, getSkillRegistry } from "./skills/index.js";
import { emitAgentEvent } from "../api/agent-events.js";

export type ToolActivity = {
  phase: "start" | "end";
  toolName: string;
  label: string;
  isError?: boolean;
};

export interface PiAgentConfig {
  model?: string;
  systemPrompt?: string;
  thinkingLevel?: "off" | "minimal" | "low" | "medium" | "high";
  timeoutMs?: number;
  timeoutMultiplier?: number; // multiplier for repair timeout (default: 2)
  selfCorrect?: boolean;
  notifyFn?: (session: string, message: string) => Promise<void>;
  webClient?: import("@slack/web-api").WebClient;
  channelIdFn?: (session: string) => Promise<string | undefined>;
}

interface ProviderAuth {
  type: string;
  refresh?: string;
  access: string;
  expires?: number;
  [key: string]: unknown;
}

interface OAuthConfig {
  anthropic?: ProviderAuth;
  google?: ProviderAuth;
  openai?: ProviderAuth;
  [provider: string]: ProviderAuth | undefined;
}

// OpenAI compatibility settings for custom providers
interface OpenAICompat {
  supportsStore?: boolean;
  supportsDeveloperRole?: boolean;
  supportsReasoningEffort?: boolean;
  supportsUsageInStreaming?: boolean;
  maxTokensField?: "max_tokens" | "max_completion_tokens";
  requiresToolResultName?: boolean;
  requiresAssistantAfterToolResult?: boolean;
  requiresThinkingAsText?: boolean;
  requiresMistralToolIds?: boolean;
}

// Custom provider model definition from ~/.pi/agent/models.json
interface CustomModelDef {
  id: string;
  name: string;
  api?: Api;
  reasoning?: boolean;
  input?: ("text" | "image")[];
  cost?: { input: number; output: number; cacheRead: number; cacheWrite: number };
  contextWindow?: number;
  maxTokens?: number;
  compat?: OpenAICompat;
}

interface CustomProviderDef {
  baseUrl: string;
  apiKey: string; // env var name or literal
  api: Api;
  models: CustomModelDef[];
}

interface CustomModelsConfig {
  providers?: Record<string, CustomProviderDef>;
}

const CUSTOM_MODELS_PATH = path.join(os.homedir(), ".pi", "agent", "models.json");
let cachedCustomModels: Map<string, Model<Api>> | null = null;
let cachedCustomProviderApiKeys: Map<string, string> | null = null; // provider -> apiKey config

/**
 * Load custom provider models from ~/.pi/agent/models.json
 */
async function loadCustomModels(): Promise<Map<string, Model<Api>>> {
  if (cachedCustomModels) return cachedCustomModels;

  cachedCustomModels = new Map();
  cachedCustomProviderApiKeys = new Map();

  try {
    const content = await fs.readFile(CUSTOM_MODELS_PATH, "utf8");
    const config: CustomModelsConfig = JSON.parse(content);

    if (config.providers) {
      for (const [providerName, providerDef] of Object.entries(config.providers)) {
        // Store API key config for this provider
        cachedCustomProviderApiKeys.set(providerName, providerDef.apiKey);

        for (const modelDef of providerDef.models) {
          const model: Model<Api> = {
            id: modelDef.id,
            name: modelDef.name,
            api: modelDef.api || providerDef.api,
            provider: providerName,
            baseUrl: providerDef.baseUrl,
            reasoning: modelDef.reasoning ?? false,
            input: modelDef.input ?? ["text"],
            cost: modelDef.cost ?? { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
            contextWindow: modelDef.contextWindow ?? 128000,
            maxTokens: modelDef.maxTokens ?? 8192,
            ...(modelDef.compat && { compat: modelDef.compat }),
          };
          cachedCustomModels.set(modelDef.id, model);
          logVerbose(`Loaded custom model: ${modelDef.id} from provider ${providerName}`);
        }
      }
    }
  } catch (err) {
    // No custom models file or invalid - that's fine
    logVerbose(`No custom models loaded: ${err}`);
  }

  return cachedCustomModels;
}

/**
 * Get API key for a custom provider - resolves env var names
 */
function getCustomProviderApiKey(provider: string): string | undefined {
  if (!cachedCustomProviderApiKeys) return undefined;
  const apiKeyConfig = cachedCustomProviderApiKeys.get(provider);
  if (!apiKeyConfig) return undefined;

  // "$OAUTH" sentinel: this provider authenticates via the OAuth access token
  // (auth.json), not a static key. Return undefined so createGetApiKey() falls
  // through to the OAuth path instead of passing the literal "$OAUTH".
  if (apiKeyConfig === "$OAUTH") return undefined;

  // Check if it's an env var name (all caps, underscores)
  if (/^[A-Z_][A-Z0-9_]*$/.test(apiKeyConfig)) {
    return process.env[apiKeyConfig];
  }
  // Otherwise treat as literal key
  return apiKeyConfig;
}

export const DEFAULT_MODEL = "claude-sonnet-4-6";

/**
 * Find model by ID - checks custom providers first, then built-in providers
 */
export async function findModel(modelId: string): Promise<{ provider: string; model: Model<Api> } | null> {
  // Check custom models first
  const customModels = await loadCustomModels();
  const customModel = customModels.get(modelId);
  if (customModel) {
    return { provider: customModel.provider, model: customModel };
  }

  // Fall back to built-in providers
  for (const provider of getProviders()) {
    const models = getModels(provider);
    const model = models.find(m => m.id === modelId);
    if (model) {
      return { provider, model: model as Model<Api> };
    }
  }
  return null;
}

const OAUTH_PATH = path.join(os.homedir(), ".pi", "agent", "auth.json");
const CODEX_CLI_AUTH_PATH = path.join(os.homedir(), ".codex", "auth.json");
const TOKEN_REFRESH_BUFFER_MS = 5 * 60 * 1000; // Refresh 5 min before expiry

/**
 * The Codex CLI (`codex login`) authenticates against the same OAuth client as
 * our openai-codex provider, so its tokens are a valid recovery source when our
 * own refresh token has died. Returns null if the file is missing or unusable.
 */
async function loadCodexCliTokens(): Promise<{ access: string; refresh: string } | null> {
  try {
    const content = await fs.readFile(CODEX_CLI_AUTH_PATH, "utf8");
    const parsed = JSON.parse(content) as {
      tokens?: { access_token?: string; refresh_token?: string };
    };
    if (!parsed.tokens?.access_token || !parsed.tokens?.refresh_token) return null;
    return { access: parsed.tokens.access_token, refresh: parsed.tokens.refresh_token };
  } catch {
    return null;
  }
}

/**
 * Load system prompt from file with session-level hierarchy:
 * 1. {sessionName}/SYSTEM.md - session-specific prompt (@username or #channelname)
 * 2. SYSTEM.md - fallback for all sessions
 *
 * Base path: ~/relay01/slack/
 */
async function loadSystemPrompt(sessionName?: string): Promise<string> {
  // Try session-specific prompt first
  if (sessionName) {
    const sessionPromptPath = path.join(SLACK_BASE_PATH, sessionName, "SYSTEM.md");
    try {
      const content = await fs.readFile(sessionPromptPath, "utf8");
      logVerbose(`Loaded session-specific system prompt from ${sessionPromptPath}`);
      return content.trim();
    } catch {
      // Session-specific not found, fall through to global
    }
  }

  // Fallback to global SYSTEM.md
  const globalPromptPath = path.join(SLACK_BASE_PATH, "SYSTEM.md");
  try {
    const content = await fs.readFile(globalPromptPath, "utf8");
    logVerbose(`Loaded global system prompt from ${globalPromptPath}`);
    return content.trim();
  } catch {
    logVerbose("No system prompt file found, using empty prompt");
    return "";
  }
}

let cachedOAuth: OAuthConfig | null = null;

async function refreshAnthropicToken(refreshToken: string): Promise<{ access: string; refresh: string; expires: number }> {
  logVerbose("Refreshing Anthropic OAuth token...");

  const response = await fetch("https://console.anthropic.com/v1/oauth/token", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      grant_type: "refresh_token",
      client_id: "9d1c250a-e61b-44d9-88ed-5944d1962f5e",
      refresh_token: refreshToken,
    }),
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Token refresh failed: ${response.status} ${text}`);
  }

  const data = await response.json() as { access_token: string; refresh_token: string; expires_in: number };
  const expires = Date.now() + (data.expires_in * 1000);

  logVerbose(`Token refreshed, expires in ${Math.round(data.expires_in / 60)} minutes`);

  return {
    access: data.access_token,
    refresh: data.refresh_token,
    expires,
  };
}

async function refreshOpenAICodexToken(refreshToken: string): Promise<{ access: string; refresh: string; expires: number }> {
  logVerbose("Refreshing OpenAI Codex OAuth token...");

  const response = await fetch("https://auth.openai.com/oauth/token", {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: refreshToken,
      client_id: "app_EMoamEEZ73f0CkXaXp7hrann",
    }),
  });

  if (!response.ok) {
    const text = await response.text().catch(() => "");
    throw new Error(`OpenAI Codex token refresh failed: ${response.status} ${text || response.statusText}`);
  }

  const data = (await response.json()) as { access_token: string; refresh_token: string; expires_in: number };

  if (!data.access_token || !data.refresh_token || typeof data.expires_in !== "number") {
    throw new Error(`OpenAI Codex token refresh response missing fields: ${JSON.stringify(data)}`);
  }

  const expires = Date.now() + data.expires_in * 1000;
  logVerbose(`OpenAI Codex token refreshed, expires: ${new Date(expires).toISOString()}`);

  return {
    access: data.access_token,
    refresh: data.refresh_token,
    expires,
  };
}

async function refreshOAuthProviderToken(provider: string, credentials: ProviderAuth): Promise<ProviderAuth> {
  if (!credentials.refresh) {
    throw new Error(`OAuth provider ${provider} is missing a refresh token`);
  }

  if (provider === "anthropic") {
    return { ...credentials, ...(await refreshAnthropicToken(credentials.refresh)) };
  }

  if (provider === "openai-codex") {
    return { ...credentials, ...(await refreshOpenAICodexToken(credentials.refresh)) };
  }

  throw new Error(`OAuth refresh is not supported for provider ${provider}`);
}

async function loadOAuth(refreshProvider?: string): Promise<OAuthConfig> {
  try {
    // Always read fresh from disk to pick up external refreshes
    const content = await fs.readFile(OAUTH_PATH, "utf8");
    const oauth: OAuthConfig = JSON.parse(content);

    let changed = false;

    for (const [provider, credentials] of Object.entries(oauth)) {
      if (!credentials) continue;
      if (refreshProvider && provider !== refreshProvider) continue;
      // Only providers we know how to refresh
      if (provider !== "anthropic" && provider !== "openai-codex") continue;

      const now = Date.now();
      const expires = credentials.expires ?? 0;

      if (expires - now < TOKEN_REFRESH_BUFFER_MS && credentials.refresh) {
        logVerbose(`${provider} token expired or expiring soon (expires: ${new Date(expires).toISOString()}), refreshing...`);

        try {
          oauth[provider] = await refreshOAuthProviderToken(provider, credentials);
          changed = true;
        } catch (refreshErr) {
          console.error(`[auth] Token refresh failed for ${provider}: ${refreshErr}`);

          // Recovery for openai-codex: fall back to the Codex CLI's tokens
          // (`codex login` writes ~/.codex/auth.json against the same OAuth
          // client), so a plain re-login fixes a dead refresh token here.
          if (provider === "openai-codex") {
            const cliTokens = await loadCodexCliTokens();
            if (cliTokens && cliTokens.refresh !== credentials.refresh) {
              console.error(
                `[auth] Falling back to Codex CLI tokens from ${CODEX_CLI_AUTH_PATH}`
              );
              oauth[provider] = {
                ...credentials,
                access: cliTokens.access,
                refresh: cliTokens.refresh,
                // Unknown real expiry; assume short-lived so the next load
                // refreshes via the (fresh) refresh token.
                expires: now + 30 * 60 * 1000,
              };
              changed = true;
            } else {
              console.error(
                `[auth] No usable Codex CLI tokens to fall back to — run \`codex login\` to recover`
              );
            }
          }
          // Otherwise continue with existing token, might still work
        }
      }
    }

    if (changed) {
      await fs.writeFile(OAUTH_PATH, JSON.stringify(oauth, null, 2));
      logVerbose("Saved refreshed OAuth tokens to disk");
    }

    cachedOAuth = oauth;
    return oauth;
  } catch (err) {
    throw new Error(`Failed to load Pi OAuth from ${OAUTH_PATH}: ${err}`);
  }
}

export function createGetApiKey(): (provider: string) => Promise<string | undefined> {
  return async (provider: string) => {
    // Check custom provider API keys first
    const customKey = getCustomProviderApiKey(provider);
    if (customKey) {
      return customKey;
    }

    // Fall back to OAuth config
    const oauth = await loadOAuth(provider);
    return (oauth as Record<string, ProviderAuth | undefined>)[provider]?.access;
  };
}

export interface AgentInstance {
  agent: Agent;
  lastActivity: number;
  messageCount: number;
  summarizing?: boolean;  // prevent concurrent summarization
  retryCount?: number;    // track failed summarization attempts
  userId?: string;        // Slack user ID (DM sessions only) for user-scoped memory
}

function formatToolName(toolName: string): string {
  const toolLabels: Record<string, string> = {
    bash: "Running command",
    read_file: "Reading file",
    write_file: "Writing file",
    web_fetch: "Fetching URL",
    web_search: "Searching web",
    glob: "Finding files",
    grep: "Searching code",
    send_message: "Sending message",
    canvas_create: "Creating canvas",
    canvas_edit: "Editing canvas",
    canvas_sections_lookup: "Looking up canvas sections",
    SLACK_FETCH_CONVERSATION_HISTORY: "Reading Slack messages",
    SLACK_POST_MESSAGE: "Posting to Slack",
    SLACK_SEARCH_MESSAGES: "Searching Slack",
  };
  return toolLabels[toolName] || `Using ${toolName.replace(/_/g, " ")}`;
}

/**
 * Manages per-sender Pi Agent instances with session persistence.
 */
export class PiAgentManager {
  private agents = new Map<string, AgentInstance>();
  private config: PiAgentConfig;
  private idleTimeoutMs: number;
  private maxMessagesBeforeSummarize = 300;
  private promptLocks = new Map<string, Promise<any>>();  // per-session locks to prevent concurrent prompts
  private pendingResets = new Map<string, Promise<void>>();  // tracks resets in progress
  private selfCorrectEnabled: boolean;

  constructor(config: PiAgentConfig = {}, idleTimeoutMinutes = 720) {
    this.config = config;
    this.idleTimeoutMs = idleTimeoutMinutes * 60 * 1000;
    this.selfCorrectEnabled = process.env.SELF_CORRECT !== "false" && (config.selfCorrect ?? true);
    // Seed ~/relay01/memory/global/MEMORY.md on first run so admins can find it
    ensureGlobalMemoryFile().catch((err) => {
      console.warn(`[pi-agent] WARNING: Failed to ensure global memory file: ${err}`);
    });
  }

  private async createAgent(
    scratchpad: Scratchpad | null,
    sessionName: string,
    userId?: string
  ): Promise<Agent> {
    const agent = new Agent({ getApiKey: createGetApiKey() });

    // Set up session-specific context
    const sessionCtx = createSessionContext(sessionName);
    logVerbose(`Session sandbox: ${sessionCtx.sessionCwd}`);

    // Session env is already loaded by getOrCreateAgent, so process.env.PI_AGENT_MODEL
    // reflects session-specific override if set
    const configuredModel = process.env.PI_AGENT_MODEL || this.config.model;
    if (configuredModel) {
      const found = await findModel(configuredModel);
      if (found) {
        agent.state.model = found.model;
        const source = process.env.PI_AGENT_MODEL ? "session .env" : "config";
        console.log(`[${sessionName}] Using model ${configuredModel} from provider ${found.provider} (source: ${source})`);
      } else {
        console.log(`[${sessionName}] Model ${configuredModel} not found, using default`);
        agent.state.model = getModel("anthropic", DEFAULT_MODEL as any);
      }
    } else {
      agent.state.model = getModel("anthropic", DEFAULT_MODEL as any);
      console.log(`[${sessionName}] Using default model ${DEFAULT_MODEL} from Anthropic`);
    }

    // Build enhanced system prompt - load from file hierarchy
    let systemPrompt = await loadSystemPrompt(sessionName);

    // Add session file path info (relative to scratchpad)
    const sessionInfo = `\nYour working directory (scratchpad): ~/relay01/slack/${sessionName}/scratchpad/\nSave important user info, preferences, and #memory items to session.md.\n`;

    // Prepend critical bullets (only if non-empty)
    if (scratchpad?.critical?.length) {
      const memoryBlock = `Memory from previous sessions:\n${scratchpad.critical.map((c) => `- ${c}`).join("\n")}\n`;
      systemPrompt = memoryBlock + sessionInfo + systemPrompt;
      logVerbose(`Injected ${scratchpad.critical.length} critical memory items into system prompt`);
    } else {
      systemPrompt = sessionInfo + systemPrompt;
    }

    // Prepend host-injected shared memory. Sessions cannot read or write
    // these files — they live outside all sandboxes.
    // Privacy rule: user-scoped memory is only injected into that user's DM,
    // never into channels.
    const isDm = sessionName.startsWith("@");
    if (isDm && userId) {
      const userMemory = await loadUserMemory(userId);
      if (userMemory) {
        systemPrompt = formatUserMemoryBlock(sessionName.slice(1), userMemory) + "\n" + systemPrompt;
        logVerbose(`Injected user memory for ${userId} (${userMemory.length} chars) into system prompt`);
      }
    }
    const globalMemory = await loadGlobalMemory();
    if (globalMemory) {
      systemPrompt = formatGlobalMemoryBlock(globalMemory) + "\n" + systemPrompt;
      logVerbose(`Injected global shared memory (${globalMemory.length} chars) into system prompt`);
    }

    // Discover convention skills
    const conventionSkills = await discoverConventionSkills({
      workspacePath: SLACK_BASE_PATH,
      sessionName,
    });

    // Add convention skills to system prompt
    if (conventionSkills.systemPromptSection) {
      systemPrompt += "\n\n" + conventionSkills.systemPromptSection;
    }

    // Add programmatic skills to system prompt
    const registry = getSkillRegistry();
    const programmaticPromptAdditions = registry.getSystemPromptAdditions();
    if (programmaticPromptAdditions) {
      systemPrompt += "\n\n" + programmaticPromptAdditions;
    }

    agent.state.systemPrompt = systemPrompt;

    if (this.config.thinkingLevel) {
      agent.state.thinkingLevel = this.config.thinkingLevel;
    }

    // Resolve channelId for canvas tools (async, best-effort)
    let resolvedChannelId: string | undefined;
    if (this.config.channelIdFn) {
      try {
        resolvedChannelId = await this.config.channelIdFn(sessionName);
      } catch {
        // non-fatal
      }
    }

    // Build canvas callbacks if webClient is available
    const canvasCallbacks = this.config.webClient
      ? (() => {
          const client = this.config.webClient!;
          return {
            create: async (args: { title?: string; markdown: string; channelId?: string }) => {
              const res = await client.canvases.create({
                title: args.title,
                document_content: { type: "markdown", markdown: args.markdown },
              } as any);
              const canvasId = (res as any).canvas_id as string;
              if (args.channelId && canvasId) {
                await client.conversations.canvases.create({
                  channel_id: args.channelId,
                  document_content: { type: "markdown", markdown: args.markdown },
                } as any).catch(() => {
                  // Fallback: share existing canvas to channel
                  return client.apiCall("canvases.access.set", {
                    canvas_id: canvasId,
                    access_level: "read",
                    channel_ids: [args.channelId],
                  } as any);
                });
              }
              return { canvas_id: canvasId };
            },
            edit: async (args: { canvas_id: string; changes: import("./pi-agent-tools.js").CanvasChange[] }) => {
              await client.canvases.edit({
                canvas_id: args.canvas_id,
                changes: args.changes,
              } as any);
            },
            sectionsLookup: async (args: { canvas_id: string; criteria: { section_types?: string[]; contains_text?: string } }) => {
              const res = await client.canvases.sections.lookup({
                canvas_id: args.canvas_id,
                criteria: args.criteria,
              } as any);
              return ((res as any).sections ?? []) as Array<{ id: string }>;
            },
          };
        })()
      : undefined;

    // Create session-specific tools (with proper sandbox isolation)
    const sessionTools = createTools(sessionName, {
      notify: this.config.notifyFn
        ? (message: string) => this.config.notifyFn!(sessionName, message)
        : undefined,
      channelId: resolvedChannelId,
      canvas: canvasCallbacks,
    });

    // Combine session tools with programmatic skill tools
    const skillTools = registry.getAllTools();
    const combinedTools = [...sessionTools, ...skillTools];
    agent.state.tools = combinedTools;
    logVerbose(`Pi agent created with ${combinedTools.length} tools: ${combinedTools.map((t) => t.name).join(", ")}`);

    // Restore recent turns as a silent context warm-up
    const skipWarmup = process.env.SKIP_CONTEXT_WARMUP === "true";
    const recentTurns = scratchpad?.recentTurns ?? [];

    if (!skipWarmup && recentTurns.length > 0) {
      const lastTurns = recentTurns.slice(-24);
      const contextLines: string[] = [];
      for (const turn of lastTurns) {
        const prefix = turn.role === "user" ? "U:" : "A:";
        contextLines.push(`${prefix} ${turn.content}`);
      }
      const contextBlock = `<session_context>\n${contextLines.join("\n")}\n</session_context>\n\nAbove is conversation history for context. Acknowledge briefly.`;

      logVerbose(`Sending ${lastTurns.length} recent turns (of ${recentTurns.length}) as context warm-up`);
      await agent.prompt(contextBlock);
      await agent.waitForIdle();
      logVerbose("Context warm-up complete, agent ready for new messages");
    } else if (skipWarmup) {
      logVerbose("Context warm-up skipped (SKIP_CONTEXT_WARMUP=true)");
    } else {
      logVerbose("Sending empty context warm-up (no recent turns)");
      await agent.prompt("New session. Acknowledge briefly.");
      await agent.waitForIdle();
      logVerbose("Empty context warm-up complete, agent ready for new messages");
    }

    return agent;
  }

  async getOrCreateAgent(
    sessionName: string,
    userId?: string
  ): Promise<{ agent: Agent; isNew: boolean }> {
    const pendingReset = this.pendingResets.get(sessionName);
    if (pendingReset) {
      logVerbose(`Waiting for pending reset to complete for ${sessionName}`);
      await pendingReset;
      logVerbose(`Pending reset complete for ${sessionName}, creating new agent`);
    }

    const existing = this.agents.get(sessionName);
    const now = Date.now();

    // Check if existing agent should be summarized (idle timeout or size guard)
    if (existing) {
      const idleTime = now - existing.lastActivity;
      const shouldSummarize =
        idleTime >= this.idleTimeoutMs ||
        existing.messageCount >= this.maxMessagesBeforeSummarize;

      if (!shouldSummarize) {
        existing.lastActivity = now;
        if (userId && !existing.userId) existing.userId = userId;
        return { agent: existing.agent, isNew: false };
      }

      // Trigger summarization (fire and forget - don't block new session)
      logVerbose(
        `Agent for ${sessionName} needs summarization (idle: ${Math.round(idleTime / 60000)}min, msgs: ${existing.messageCount})`
      );
      this.triggerSummarization(sessionName, existing);
    }

    // Load session-specific .env (e.g., ~/relay01/slack/@saad/.env)
    loadSessionEnv(sessionName);

    // Record user ID ↔ username mapping for DM sessions (usernames change,
    // the ID is the stable memory key)
    if (userId && sessionName.startsWith("@")) {
      recordUserIdentity(userId, sessionName.slice(1)).catch((err) => {
        console.warn(`[pi-agent] WARNING: Failed to record user identity: ${err}`);
      });
    }

    // Create new agent with scratchpad context
    const scratchpad = await loadScratchpad(sessionName);
    const agent = await this.createAgent(scratchpad, sessionName, userId);
    this.agents.set(sessionName, {
      agent,
      lastActivity: now,
      messageCount: 0,
      userId,
    });
    logVerbose(`Created new Pi agent for ${sessionName}`);
    return { agent, isNew: true };
  }

  /**
   * Summarize and save session state before evicting agent
   */
  private async triggerSummarization(
    sessionName: string,
    instance: AgentInstance
  ): Promise<void> {
    if (instance.summarizing) {
      logVerbose(`Summarization already in progress for ${sessionName}`);
      return;
    }
    instance.summarizing = true;

    try {
      const messages = instance.agent.state.messages as unknown as Message[];
      const existingScratchpad = await loadScratchpad(sessionName);
      const isDm = sessionName.startsWith("@");
      const result = await summarizeSession(messages, existingScratchpad, { isDm });
      await saveScratchpad(sessionName, result);

      // Harvest promoted facts into the shared-memory inboxes (host-side;
      // sessions never touch these files). Fire and forget — memory
      // promotion must never block or fail eviction.
      const timestamp = new Date().toISOString();
      if (result.promote.length > 0) {
        proposeGlobalFacts(
          result.promote.map((text) => ({ text, sourceSession: sessionName, timestamp })),
        )
          .then(() => maybeConsolidateGlobalMemory(callSummarizerWithAgent))
          .catch((err) => {
            console.warn(`[pi-agent] WARNING: Failed to harvest promoted facts: ${err}`);
          });
      }
      // User-scoped facts are only harvested from DMs (privacy rule: facts
      // about a user learned in their DM stay keyed to their user ID and
      // are only ever injected back into their DM)
      if (isDm && instance.userId && result.promoteUser.length > 0) {
        const userId = instance.userId;
        proposeUserFacts(
          userId,
          result.promoteUser.map((text) => ({ text, sourceSession: sessionName, timestamp })),
        )
          .then(() => maybeConsolidateUserMemory(userId, callSummarizerWithAgent))
          .catch((err) => {
            console.warn(`[pi-agent] WARNING: Failed to harvest user facts: ${err}`);
          });
      }

      // Success - evict agent
      instance.agent.abort();
      this.agents.delete(sessionName);
      logVerbose(`Summarized and evicted session for ${sessionName}`);
    } catch (err) {
      instance.retryCount = (instance.retryCount ?? 0) + 1;
      instance.summarizing = false;

      if (instance.retryCount < 2) {
        // First failure: extend timeout for retry
        instance.lastActivity = Date.now();
        logVerbose(`Summarization failed for ${sessionName}, will retry: ${err}`);
      } else {
        // Second failure: evict anyway to prevent infinite memory growth
        console.warn(
          `[pi-agent] WARNING: Summarization failed twice for ${sessionName}, evicting without save: ${err}`
        );
        instance.agent.abort();
        this.agents.delete(sessionName);
      }
    }
  }

  async prompt(
    sessionName: string,
    message: string,
    options: { timeoutMs?: number; userId?: string; onToolActivity?: (activity: ToolActivity) => void } = {}
  ): Promise<{ text: string; isNew: boolean; messageCount: number }> {
    // Queue prompts per session to prevent concurrent access to same agent
    const existingLock = this.promptLocks.get(sessionName) ?? Promise.resolve();

    const doPrompt = async (): Promise<{ text: string; isNew: boolean; messageCount: number }> => {
      // Wait for any existing prompt to complete first
      await existingLock.catch(() => {}); // ignore errors from previous prompt

      const { agent, isNew } = await this.getOrCreateAgent(sessionName, options.userId);
      const instance = this.agents.get(sessionName)!;
      instance.messageCount++;

      const timeoutMs = options.timeoutMs || this.config.timeoutMs || 120000;
      let responseText = "";
      let seq = 0;

      // Self-correction types & state
      type AttemptLabel = "primary" | "repair";
      type ToolFailure = {
        toolName: string;
        toolCallId: string;
        result?: unknown;
      };
      const toolFailures: Record<AttemptLabel, ToolFailure[]> = {
        primary: [],
        repair: [],
      };
      let activeAttempt: AttemptLabel = "primary";

      const verifyAfterFailure = (text: string, failures: ToolFailure[]) => {
        if (failures.length > 0) {
          return { ok: false as const, reason: "tool_error" as const, failedTools: failures };
        }
        if (text.trim().length === 0) {
          return { ok: false as const, reason: "empty_response" as const, failedTools: [] as ToolFailure[] };
        }
        return { ok: true as const, reason: "" as const, failedTools: [] as ToolFailure[] };
      };

      const formatToolFailures = (failures: ToolFailure[]): string => {
        if (failures.length === 0) return "";
        return failures
          .map((f) => {
            let result = "";
            if (f.result !== undefined) {
              try { result = JSON.stringify(f.result); } catch { result = String(f.result); }
            }
            return `- ${f.toolName} (${f.toolCallId})${result ? `: ${result}` : ""}`;
          })
          .join("\n");
      };

      const extractLatestAssistantText = (): string => {
        const messages = agent.state.messages;
        for (let i = messages.length - 1; i >= 0; i--) {
          const msg = messages[i];
          if ("role" in msg && msg.role === "user") break;
          if ("content" in msg && Array.isArray(msg.content)) {
            const texts = msg.content
              .filter((c): c is TextContent => c.type === "text")
              .map((c) => c.text)
              .filter((t) => t.trim().length > 0);
            if (texts.length > 0) return texts.join("\n");
          }
        }
        return "";
      };

      // Subscribe to events to capture response and track tool failures
      const startTimes = new Map<string, number>();
      const unsubscribe = agent.subscribe((event: AgentEvent) => {
        if (isVerbose()) {
          logVerbose(`Pi agent event: ${event.type}`);
        }
        if (event.type === "tool_execution_start") {
          const label = formatToolName(event.toolName);
          startTimes.set(event.toolCallId, Date.now());
          options.onToolActivity?.({ phase: "start", toolName: event.toolName, label });
          emitAgentEvent({
            session: sessionName,
            seq: seq++,
            phase: "start",
            toolName: event.toolName,
            label,
            ts: Date.now(),
          });
        }
        if (event.type === "tool_execution_end") {
          const durationMs = Date.now() - (startTimes.get(event.toolCallId) ?? Date.now());
          options.onToolActivity?.({
            phase: "end",
            toolName: event.toolName,
            label: formatToolName(event.toolName),
            isError: event.isError,
          });
          emitAgentEvent({
            session: sessionName,
            seq: seq++,
            phase: "end",
            toolName: event.toolName,
            label: formatToolName(event.toolName),
            isError: event.isError,
            durationMs,
            ts: Date.now(),
          });
          if (event.isError) {
            toolFailures[activeAttempt].push({
              toolName: event.toolName,
              toolCallId: event.toolCallId,
              result: event.result,
            });
            logVerbose(`[${sessionName}] Tool failure [${activeAttempt}]: ${event.toolName}`);
          }
        }
      });

      const runAttempt = async (
        attempt: AttemptLabel,
        promptMessage: string,
        attemptTimeoutMs: number,
      ): Promise<string> => {
        activeAttempt = attempt;

        // Countdown that pauses while a write-approval is waiting on a human,
        // so a slow Approve/Deny decision can't kill the run mid-tool-call.
        const timeoutPromise = new Promise<never>((_, reject) => {
          const tickMs = 5000;
          let remaining = attemptTimeoutMs;
          const tick = async () => {
            try {
              const { getApprovalManager } = await import("./approvals.js");
              if (!getApprovalManager().hasPendingForSession(sessionName)) {
                remaining -= tickMs;
              }
            } catch {
              remaining -= tickMs;
            }
            if (remaining <= 0) reject(new Error("Agent timeout"));
            else setTimeout(tick, Math.min(tickMs, remaining));
          };
          setTimeout(tick, Math.min(tickMs, remaining));
        });

        await Promise.race([agent.prompt(promptMessage), timeoutPromise]);
        await agent.waitForIdle();

        return extractLatestAssistantText();
      };

      try {
        // Primary attempt
        let primaryResponse: string;
        let primaryTimedOut = false;

        try {
          primaryResponse = await runAttempt("primary", message, timeoutMs);
        } catch (err) {
          if (
            this.selfCorrectEnabled &&
            err instanceof Error &&
            err.message === "Agent timeout"
          ) {
            primaryTimedOut = true;
            primaryResponse = extractLatestAssistantText();
            logVerbose(`[${sessionName}] Primary attempt timed out after ${timeoutMs}ms`);
          } else {
            throw err;
          }
        }

        responseText = primaryResponse;

        // Self-correction: verify and repair if needed
        if (this.selfCorrectEnabled) {
          const primaryVerification = primaryTimedOut
            ? { ok: false as const, reason: "timeout" as const, failedTools: toolFailures.primary }
            : verifyAfterFailure(primaryResponse, toolFailures.primary);

          logVerbose(
            `[${sessionName}] Primary verification: ok=${primaryVerification.ok}${primaryVerification.ok ? "" : ` reason=${primaryVerification.reason}`}`
          );

          if (!primaryVerification.ok) {
            logVerbose(`[${sessionName}] Starting repair attempt`);
            const repairTimeoutMs = primaryTimedOut
              ? Math.round(timeoutMs * (this.config.timeoutMultiplier ?? 2))
              : timeoutMs;
            const failureSummary = formatToolFailures(primaryVerification.failedTools);
            const repairInstruction = [
              primaryTimedOut
                ? "The previous attempt timed out before completing."
                : "The previous attempt failed due to tool errors or an empty response.",
              `User message:\n${message}`,
              ...(failureSummary ? [`Failures:\n${failureSummary}`] : []),
              "Retry only the failed tool calls and return a final answer.",
            ].join("\n\n");

            try {
              const repairResponse = await runAttempt("repair", repairInstruction, repairTimeoutMs);
              const repairVerification = verifyAfterFailure(repairResponse, toolFailures.repair);
              logVerbose(
                `[${sessionName}] Repair verification: ok=${repairVerification.ok}${repairVerification.ok ? "" : ` reason=${repairVerification.reason}`}`
              );

              responseText = repairVerification.ok
                ? repairResponse
                : "I couldn't complete that request. Please try again.";
            } catch {
              responseText = "I couldn't complete that request. Please try again.";
            }
          }
        }

        instance.lastActivity = Date.now();
        return {
          text: responseText,
          isNew,
          messageCount: instance.messageCount,
        };
      } catch (err) {
        agent.abort();
        throw err;
      } finally {
        unsubscribe();
      }
    };

    // Set up the lock and execute
    const promptPromise = doPrompt();
    this.promptLocks.set(sessionName, promptPromise);

    try {
      return await promptPromise;
    } finally {
      // Clean up lock if this was the last one
      if (this.promptLocks.get(sessionName) === promptPromise) {
        this.promptLocks.delete(sessionName);
      }
    }
  }

  resetSession(sessionName: string): boolean {
    const instance = this.agents.get(sessionName);
    if (!instance) {
      return false;
    }

    if (this.pendingResets.has(sessionName)) {
      logVerbose(`Reset already in progress for ${sessionName}`);
      return true;
    }

    logVerbose(`Reset requested for ${sessionName}, queuing summarization`);

    const resetPromise = (async () => {
      try {
        if (!instance.summarizing) {
          instance.summarizing = true;
          const messages = instance.agent.state.messages as unknown as Message[];
          const existingScratchpad = await loadScratchpad(sessionName);
          const result = await summarizeSession(messages, existingScratchpad);
          await saveScratchpad(sessionName, result);
          logVerbose(`Summarization complete for ${sessionName} during reset`);
        }
      } catch (err) {
        console.warn(`[pi-agent] WARNING: Summarization failed during reset for ${sessionName}: ${err}`);
      } finally {
        instance.agent.abort();
        this.agents.delete(sessionName);
        this.pendingResets.delete(sessionName);
        logVerbose(`Reset complete for ${sessionName}, agent evicted`);
      }
    })();

    this.pendingResets.set(sessionName, resetPromise);
    return true;
  }

  resetAllSessions(): number {
    const sessionNames = [...this.agents.keys()];
    let count = 0;
    for (const sessionName of sessionNames) {
      if (this.resetSession(sessionName)) {
        count++;
      }
    }
    return count;
  }

  getSessionInfo(sessionName: string): { messageCount: number; idleMs: number } | null {
    const instance = this.agents.get(sessionName);
    if (!instance) return null;
    return {
      messageCount: instance.messageCount,
      idleMs: Date.now() - instance.lastActivity,
    };
  }

  cleanup(): void {
    const now = Date.now();
    for (const [senderId, instance] of this.agents) {
      if (now - instance.lastActivity > this.idleTimeoutMs) {
        // Trigger summarization before cleanup
        logVerbose(`Cleanup: triggering summarization for idle agent ${senderId}`);
        this.triggerSummarization(senderId, instance);
      }
    }
  }

  get activeAgentCount(): number {
    return this.agents.size;
  }
}

// Singleton manager instance
let globalManager: PiAgentManager | null = null;

export function getPiAgentManager(config?: PiAgentConfig, idleMinutes?: number): PiAgentManager {
  if (!globalManager) {
    globalManager = new PiAgentManager(config, idleMinutes);
  }
  return globalManager;
}

export function resetPiAgentManager(): void {
  if (globalManager) {
    globalManager.resetAllSessions();
    globalManager = null;
  }
}
