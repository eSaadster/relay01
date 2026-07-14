// Agent sub-system type definitions — autonomous pi CLI child processes

/**
 * Frontmatter configuration from an agent definition .md file.
 */
export interface AgentDefinitionFrontmatter {
  /** Maximum duration before timeout (e.g., "30m", "2h") */
  timeout?: string;

  /** Working directory for the agent */
  cwd?: string;

  /** Optional: specific model for this agent (overrides PI_MODEL env var) */
  model?: string;

}

/**
 * Parsed agent definition from a .md file.
 */
export interface AgentDefinition {
  /** Definition ID (filename without .md, or directory name) */
  id: string;

  /** Full path to definition file */
  path: string;

  /** Parsed frontmatter config */
  config: AgentDefinitionFrontmatter;

  /** Markdown body (instructions for the agent) */
  instructions: string;

  /** Whether this is a chain definition */
  isChain: boolean;

  /** Path to mcporter.json if definition has MCP config (for directory-based definitions) */
  mcpConfigPath?: string;
}

/**
 * A step in a chain definition.
 */
export interface ChainStep {
  /** Step name */
  name: string;

  /** Prompt template with {task} and {previous} placeholders */
  prompt: string;

  /** Failure policy for this step: "stop" (default) or "continue" */
  onFailure?: "stop" | "continue";
}

/**
 * Chain definition parsed from *.chain.md files.
 */
export interface ChainDefinition {
  /** Chain ID */
  id: string;

  /** Full path to chain file */
  path: string;

  /** Parsed frontmatter config */
  config: AgentDefinitionFrontmatter;

  /** Sequential steps */
  steps: ChainStep[];
}

/**
 * Status of an agent run.
 */
export type AgentRunStatus =
  | "running"
  | "completed"
  | "failed"
  | "timeout"
  | "stopped";

/**
 * Runtime state of an agent run (status.json).
 */
export interface AgentRun {
  /** Schema version */
  version: 1;

  /** Unique run ID (e.g., "research-abc12345") */
  id: string;

  /** Definition ID used to create this run */
  definitionId: string;

  /** Slack session that owns this run (e.g., "@username" or "#channel") */
  session: string;

  /** Working directory for the agent */
  cwd: string;

  /** OS process ID of the pi child process */
  pid?: number;

  /** Current status */
  status: AgentRunStatus;

  /** ISO timestamp when run started */
  started: string;

  /** ISO timestamp when run ended */
  ended?: string;

  /** User's original request/prompt */
  userPrompt: string;

  /** Error message if failed */
  error?: string;

  /** Chain step tracking */
  steps?: {
    /** Total number of steps */
    total: number;
    /** Index of currently executing step (0-based) */
    current: number;
    /** Results per step */
    results: Array<{
      name: string;
      status: AgentRunStatus;
      startedAt: string;
      endedAt?: string;
      error?: string;
    }>;
  };
}

/**
 * Event record for events.jsonl.
 */
export interface AgentRunEvent {
  /** ISO timestamp */
  time: string;

  /** Event type */
  type:
    | "started"
    | "output"
    | "step_started"
    | "step_completed"
    | "step_failed"
    | "completed"
    | "failed"
    | "timeout"
    | "stopped"
;

  /** Chain step index (if applicable) */
  step?: number;

  /** Event-specific data */
  data?: string;
}

/**
 * Configuration for AgentRunManager.
 */
export interface AgentRunManagerConfig {
  /** Path to definitions directory */
  definitionsPath: string;

  /** Maximum concurrent agent runs */
  maxConcurrent: number;

  /** Function to send notifications via Slack */
  sendNotification: (session: string, message: string) => Promise<void>;

}

/**
 * Agent-specific config in relay01.json.
 */
export interface AgentsConfig {
  /** Path to agent definitions directory (default: ~/relay01/agents/definitions) */
  definitionsPath?: string;

  /** Max concurrent agent runs (default: 3) */
  maxConcurrent?: number;

}

/**
 * Discovered definitions from filesystem.
 */
export interface DiscoveredDefinitions {
  definitions: AgentDefinition[];
  errors: Array<{ path: string; error: string }>;
}
