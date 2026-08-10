import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import JSON5 from "json5";
import { z } from "zod";

export type ReplyMode = "text" | "command" | "pi-agent";
export type ClaudeOutputFormat = "text" | "json" | "stream-json";
export type ThinkingLevel = "off" | "minimal" | "low" | "medium" | "high";
export type SessionScope = "per-sender" | "global";

export type GroupChatConfig = {
  enabled?: boolean; // default: true
  requireMention?: boolean; // default: true
  mentionPatterns?: string[]; // regex patterns to trigger in groups, default: ["@?relay01"]
  historyLimit?: number; // max messages to keep per group, default: 50
  systemPrompt?: string; // optional system prompt override for group chats
};

export type SessionConfig = {
  scope?: SessionScope;
  resetTriggers?: string[];
  idleMinutes?: number;
  store?: string;
  sessionArgNew?: string[];
  sessionArgResume?: string[];
  sessionArgBeforeBody?: boolean;
  sendSystemOnce?: boolean;
  sessionIntro?: string;
  typingIntervalSeconds?: number;
  // Note: heartbeat replaced by clicks system - see src/auto-reply/clicks/
};

export type LoggingConfig = {
  level?: "silent" | "fatal" | "error" | "warn" | "info" | "debug" | "trace";
  file?: string;
};

export type WebReconnectConfig = {
  initialMs?: number;
  maxMs?: number;
  factor?: number;
  jitter?: number;
  maxAttempts?: number; // 0 = unlimited
};

export type WebConfig = {
  heartbeatSeconds?: number;
  reconnect?: WebReconnectConfig;
};

export type McpConfig = {
  configPath?: string; // path to mcporter.json, default: ~/relay01/slack/mcporter.json
  enabled?: boolean; // default: true
};

export type AgentsConfig = {
  definitionsPath?: string; // default: ~/relay01/agents/definitions
  maxConcurrent?: number;   // default: 3
  model?: string;           // default model for runs whose definition sets none
};

export type Relay01Config = {
  logging?: LoggingConfig;
  groupChat?: GroupChatConfig;
  mcp?: McpConfig;
  agents?: AgentsConfig;
  inbound?: {
    allowFrom?: string[]; // sender IDs allowed to trigger auto-reply
    transcribeAudio?: {
      // Optional CLI to turn inbound audio into text; templated args, must output transcript to stdout.
      command: string[];
      timeoutSeconds?: number;
    };
    reply?: {
      mode: ReplyMode;
      text?: string; // for mode=text, can contain {{Body}}
      command?: string[]; // for mode=command, argv with templates
      cwd?: string; // working directory for command execution
      template?: string; // prepend template string when building command/prompt
      timeoutSeconds?: number; // optional command timeout; defaults to 600s
      bodyPrefix?: string; // optional string prepended to Body before templating
      mediaUrl?: string; // optional media attachment (path or URL)
      session?: SessionConfig;
      piOutputFormat?: ClaudeOutputFormat; // when command starts with `pi`, force an output format
      // Deprecated: claudeOutputFormat for backward compatibility
      claudeOutputFormat?: ClaudeOutputFormat;
      mediaMaxMb?: number; // optional cap for outbound media (default 5MB)
      typingIntervalSeconds?: number; // how often to refresh typing indicator while command runs
      // Note: heartbeat replaced by clicks system - see src/auto-reply/clicks/
      // pi-agent mode options
      piAgentModel?: string; // model ID for pi-agent mode (set via PI_AGENT_MODEL env var)
      piAgentSystemPrompt?: string; // system prompt for pi-agent mode
      piAgentThinkingLevel?: ThinkingLevel; // thinking level for pi-agent mode
    };
  };
  web?: WebConfig;
};

export const CONFIG_PATH = path.join(os.homedir(), ".relay01", "relay01.json");

const ReplySchema = z
  .object({
    mode: z.union([z.literal("text"), z.literal("command"), z.literal("pi-agent")]),
    text: z.string().optional(),
    command: z.array(z.string()).optional(),
    cwd: z.string().optional(),
    template: z.string().optional(),
    timeoutSeconds: z.number().int().positive().optional(),
    bodyPrefix: z.string().optional(),
    mediaUrl: z.string().optional(),
    mediaMaxMb: z.number().positive().optional(),
    typingIntervalSeconds: z.number().int().positive().optional(),
    session: z
      .object({
        scope: z
          .union([z.literal("per-sender"), z.literal("global")])
          .optional(),
        resetTriggers: z.array(z.string()).optional(),
        idleMinutes: z.number().int().positive().optional(),
        store: z.string().optional(),
        sessionArgNew: z.array(z.string()).optional(),
        sessionArgResume: z.array(z.string()).optional(),
        sessionArgBeforeBody: z.boolean().optional(),
        sendSystemOnce: z.boolean().optional(),
        sessionIntro: z.string().optional(),
        typingIntervalSeconds: z.number().int().positive().optional(),
      })
      .optional(),
    claudeOutputFormat: z
      .union([
        z.literal("text"),
        z.literal("json"),
        z.literal("stream-json"),
        z.undefined(),
      ])
      .optional(),
    piOutputFormat: z
      .union([
        z.literal("text"),
        z.literal("json"),
        z.literal("stream-json"),
        z.undefined(),
      ])
      .optional(),
    piAgentModel: z.string().optional(),
    piAgentSystemPrompt: z.string().optional(),
    piAgentThinkingLevel: z
      .union([
        z.literal("off"),
        z.literal("minimal"),
        z.literal("low"),
        z.literal("medium"),
        z.literal("high"),
      ])
      .optional(),
  })
  .refine(
    (val) => {
      if (val.mode === "text") return Boolean(val.text);
      if (val.mode === "command") return Boolean(val.command);
      if (val.mode === "pi-agent") return true; // pi-agent doesn't require text or command
      return false;
    },
    {
      message:
        "reply.text is required for mode=text; reply.command is required for mode=command",
    },
  );

const GroupChatSchema = z
  .object({
    enabled: z.boolean().optional(),
    requireMention: z.boolean().optional(),
    mentionPatterns: z.array(z.string()).optional(),
    historyLimit: z.number().int().positive().optional(),
    systemPrompt: z.string().optional(),
  })
  .optional();

const McpSchema = z
  .object({
    configPath: z.string().optional(),
    enabled: z.boolean().optional(),
  })
  .optional();

const AgentsSchema = z
  .object({
    definitionsPath: z.string().optional(),
    maxConcurrent: z.number().int().positive().optional(),
    model: z.string().optional(),
  })
  .optional();

const Relay01Schema = z.object({
  logging: z
    .object({
      level: z
        .union([
          z.literal("silent"),
          z.literal("fatal"),
          z.literal("error"),
          z.literal("warn"),
          z.literal("info"),
          z.literal("debug"),
          z.literal("trace"),
        ])
        .optional(),
      file: z.string().optional(),
    })
    .optional(),
  groupChat: GroupChatSchema,
  mcp: McpSchema,
  inbound: z
    .object({
      allowFrom: z.array(z.string()).optional(),
      transcribeAudio: z
        .object({
          command: z.array(z.string()),
          timeoutSeconds: z.number().int().positive().optional(),
        })
        .optional(),
      reply: ReplySchema.optional(),
    })
    .optional(),
  web: z
    .object({
      heartbeatSeconds: z.number().int().positive().optional(),
      reconnect: z
        .object({
          initialMs: z.number().positive().optional(),
          maxMs: z.number().positive().optional(),
          factor: z.number().positive().optional(),
          jitter: z.number().min(0).max(1).optional(),
          maxAttempts: z.number().int().min(0).optional(),
        })
        .optional(),
    })
    .optional(),
  agents: AgentsSchema,
});

export function loadConfig(): Relay01Config {
  // Read ~/.relay01/relay01.json (JSON5) if present.
  try {
    if (!fs.existsSync(CONFIG_PATH)) return {};
    const raw = fs.readFileSync(CONFIG_PATH, "utf-8");
    const parsed = JSON5.parse(raw);
    if (typeof parsed !== "object" || parsed === null) return {};
    const validated = Relay01Schema.safeParse(parsed);
    if (!validated.success) {
      console.error("Invalid relay01 config:");
      for (const iss of validated.error.issues) {
        console.error(`- ${iss.path.join(".")}: ${iss.message}`);
      }
      return {};
    }
    return validated.data as Relay01Config;
  } catch (err) {
    console.error(`Failed to read config at ${CONFIG_PATH}`, err);
    return {};
  }
}
