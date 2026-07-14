// Events system type definitions

import type { WebClient } from "@slack/web-api";

/**
 * Base event configuration.
 */
interface EventBase {
  /** Event text/instructions for the agent */
  text: string;

  /** Optional: suppress Slack notification if agent responds with [SILENT] */
  allowSilent?: boolean;
}

/**
 * Immediate event - executes instantly when file is detected.
 * File is deleted after processing.
 */
export interface ImmediateEvent extends EventBase {
  type: "immediate";
}

/**
 * One-shot event - executes at specified datetime.
 * Uses ISO 8601 format with timezone offset (e.g., "2024-01-15T14:30:00+05:00").
 * File is deleted after execution. Past timestamps cause immediate deletion without execution.
 */
export interface OneShotEvent extends EventBase {
  type: "one-shot";
  /** ISO 8601 datetime with timezone offset */
  datetime: string;
}

/**
 * Periodic event - executes on cron schedule.
 * Uses standard cron syntax with optional seconds field.
 * File persists until explicitly deleted.
 */
export interface PeriodicEvent extends EventBase {
  type: "periodic";
  /** Cron expression (e.g., "0 *\/2 * * *" for every 2 hours) */
  cron: string;
  /** IANA timezone name (e.g., "America/New_York"). Defaults to system timezone. */
  timezone?: string;
}

export type EventConfig = ImmediateEvent | OneShotEvent | PeriodicEvent;

/**
 * Parsed event with metadata.
 */
export interface ParsedEvent {
  /** Filename (e.g., "health-check.json") */
  filename: string;
  /** Full path to event file */
  filepath: string;
  /** Session name (@username or #channelname) */
  sessionName: string;
  /** Parsed event configuration */
  config: EventConfig;
  /** File modification time */
  mtime: number;
}

/**
 * Active event tracking.
 */
export interface ActiveEvent {
  event: ParsedEvent;
  /** Timer handle (setTimeout for one-shot, Cron instance for periodic) */
  handle: NodeJS.Timeout | { stop: () => void };
  /** Type of handle for cleanup */
  handleType: "timeout" | "cron";
}

/**
 * Result of event execution.
 */
export interface EventResult {
  /** Whether execution succeeded */
  success: boolean;
  /** Agent's response text */
  response?: string;
  /** Whether agent requested silent (no Slack notification) */
  silent?: boolean;
  /** Error message if failed */
  error?: string;
  /** Execution duration in ms */
  durationMs: number;
}

/**
 * Configuration for EventsWatcher.
 */
export interface EventsWatcherConfig {
  /** Slack WebClient for sending messages */
  webClient: WebClient;
  /** Function to resolve session name to channel ID */
  getSessionChannelId: (sessionName: string) => Promise<string | undefined>;
}
