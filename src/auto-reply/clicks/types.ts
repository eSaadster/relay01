// Clicks system type definitions

import type { WebClient } from "@slack/web-api";

/**
 * Configuration for a single click (scheduled task).
 */
export interface ClickConfig {
  /** Unique identifier for this click */
  id: string;

  /** Human-readable name */
  name: string;

  /** Instructions for the agent to execute */
  instructions: string;

  /** Interval in minutes between executions */
  intervalMinutes: number;

  /** Optional: explicit alert criteria (if not set, agent decides) */
  alertCriteria?: string;

  /** Optional: disable without removing (default: true) */
  enabled?: boolean;

  /** Optional: specific model for this click (overrides session default) */
  model?: string;
}

/**
 * Contents of a clicks.json file.
 */
export interface ClicksFile {
  /** Array of click configurations */
  clicks: ClickConfig[];

  /** For project-level clicks: channel to send alerts to (e.g., "#alerts") */
  alertChannel?: string;
}

/**
 * Persistent state for a single click.
 */
export interface ClickState {
  clickId: string;
  lastRunTime: number;      // epoch ms
  lastResult?: "OK" | "ALERT" | "ERROR";
  lastSummary?: string;
  lastAlertTime?: number;   // epoch ms of last alert sent
  consecutiveFailures: number;
  /** Message IDs (ts values) that have been processed - for deduplication */
  processedMessageIds?: string[];
}

/**
 * Aggregated state for all clicks in a session.
 */
export interface ClicksStateFile {
  [clickId: string]: ClickState;
}

/**
 * Context for executing a click.
 */
export interface ClickContext {
  /** Session name (@username or #channelname, or "project" for global) */
  sessionName: string;

  /** Path to clicks.json file */
  clicksFilePath: string;

  /** Path to scratchpad/clicks/ folder for state storage */
  scratchpadPath: string;

  /** Slack channel ID or session name to send alerts to */
  alertTarget: string;

  /** Whether this is a project-level click */
  isProjectLevel: boolean;
}

/**
 * Result of executing a click.
 */
export interface ClickResult {
  /** Whether an alert should be sent */
  shouldAlert: boolean;

  /** Brief summary of findings */
  summary: string;

  /** Detailed findings */
  details: string;

  /** Execution timestamp */
  timestamp: number;

  /** Execution duration in ms */
  durationMs: number;

  /** Any error that occurred */
  error?: string;
}

/**
 * Discovered clicks from filesystem.
 */
export interface DiscoveredClicks {
  sessionClicks: Array<{
    sessionName: string;
    config: ClicksFile;
    context: ClickContext;
  }>;
  projectClicks: {
    config: ClicksFile;
    context: ClickContext;
  } | null;
}

/**
 * Configuration passed to ClickScheduler.start()
 */
export interface ClickSchedulerConfig {
  /** Slack WebClient for sending alerts */
  webClient: WebClient;

  /** Function to resolve #channel name to channel ID */
  getChannelByName: (name: string) => string | undefined;

  /** Function to get channel ID for a session DM */
  getSessionChannelId?: (sessionName: string) => Promise<string | undefined>;
}
