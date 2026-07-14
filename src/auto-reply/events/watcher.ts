/**
 * Events Watcher - monitors event files and wakes up session agents.
 *
 * Unlike clicks (which spawn isolated agents), events wake up the SAME
 * session agent with full conversation history and context.
 */

import { watch, type FSWatcher } from "node:fs";
import { readFile, readdir, stat, unlink, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { Cron } from "croner";
import type { WebClient } from "@slack/web-api";

import { SLACK_BASE_PATH } from "../pi-agent-tools.js";
import { getPiAgentManager } from "../pi-agent.js";
import type {
  EventConfig,
  ParsedEvent,
  ActiveEvent,
  EventsWatcherConfig,
  EventResult,
} from "./types.js";

const EVENTS_DIR = "events";
const DEBOUNCE_MS = 100;

/**
 * Global events watcher - monitors all session event directories.
 */
export class EventsWatcher {
  private config: EventsWatcherConfig | null = null;
  private watchers = new Map<string, FSWatcher>();
  private activeEvents = new Map<string, ActiveEvent>();
  private debounceTimers = new Map<string, NodeJS.Timeout>();
  private started = false;
  private scanInterval: NodeJS.Timeout | null = null;
  private startupTime = Date.now();

  /**
   * Generate unique key for an event.
   */
  private eventKey(sessionName: string, filename: string): string {
    return `${sessionName}:${filename}`;
  }

  /**
   * Start the events watcher.
   */
  async start(config: EventsWatcherConfig): Promise<void> {
    if (this.started) {
      console.warn("[events] Watcher already started");
      return;
    }

    this.config = config;
    this.started = true;
    this.startupTime = Date.now();

    console.log("[events] Starting events watcher...");

    await this.scanAllSessions();

    // Rescan for new sessions every 60 seconds
    this.scanInterval = setInterval(() => {
      void this.scanAllSessions();
    }, 60_000);
    this.scanInterval.unref();

    console.log("[events] Watcher started");
  }

  /**
   * Stop the events watcher.
   */
  stop(): void {
    if (!this.started) return;

    console.log("[events] Stopping events watcher...");

    // Clear scan interval
    if (this.scanInterval) {
      clearInterval(this.scanInterval);
      this.scanInterval = null;
    }

    // Clear all debounce timers
    for (const timer of this.debounceTimers.values()) {
      clearTimeout(timer);
    }
    this.debounceTimers.clear();

    // Stop all file watchers
    for (const [session, watcher] of this.watchers) {
      watcher.close();
      console.log(`[events] Stopped watching ${session}`);
    }
    this.watchers.clear();

    // Cancel all scheduled events
    for (const [key, active] of this.activeEvents) {
      this.cancelEvent(key, active);
    }
    this.activeEvents.clear();

    this.started = false;
    console.log("[events] Watcher stopped");
  }

  /**
   * Scan all session directories for events folders.
   */
  private async scanAllSessions(): Promise<void> {
    try {
      const entries = await readdir(SLACK_BASE_PATH, { withFileTypes: true });

      for (const entry of entries) {
        // Only process session directories (@user or #channel)
        if (!entry.isDirectory()) continue;
        if (!entry.name.startsWith("@") && !entry.name.startsWith("#")) continue;

        const sessionName = entry.name;
        const eventsDir = join(SLACK_BASE_PATH, sessionName, EVENTS_DIR);

        // Check if events directory exists
        try {
          const dirStat = await stat(eventsDir);
          if (dirStat.isDirectory() && !this.watchers.has(sessionName)) {
            await this.watchSession(sessionName, eventsDir);
          }
        } catch {
          // No events directory for this session - that's fine
        }
      }
    } catch (err) {
      console.error("[events] Failed to scan sessions:", err);
    }
  }

  /**
   * Start watching a session's events directory.
   */
  private async watchSession(sessionName: string, eventsDir: string): Promise<void> {
    console.log(`[events] Watching ${sessionName}/events/`);

    // Process existing event files
    await this.processEventsDir(sessionName, eventsDir);

    // Watch for changes
    try {
      const watcher = watch(eventsDir, (eventType, filename) => {
        if (!filename || !filename.endsWith(".json")) return;

        // Debounce rapid changes
        const key = this.eventKey(sessionName, filename);
        const existing = this.debounceTimers.get(key);
        if (existing) clearTimeout(existing);

        this.debounceTimers.set(
          key,
          setTimeout(() => {
            this.debounceTimers.delete(key);
            void this.handleFileChange(sessionName, eventsDir, filename);
          }, DEBOUNCE_MS)
        );
      });

      this.watchers.set(sessionName, watcher);
    } catch (err) {
      console.error(`[events] Failed to watch ${sessionName}:`, err);
    }
  }

  /**
   * Process all event files in a directory.
   */
  private async processEventsDir(sessionName: string, eventsDir: string): Promise<void> {
    try {
      const files = await readdir(eventsDir);

      for (const filename of files) {
        if (!filename.endsWith(".json")) continue;
        await this.handleFileChange(sessionName, eventsDir, filename);
      }
    } catch (err) {
      console.error(`[events] Failed to process ${sessionName}/events/:`, err);
    }
  }

  /**
   * Handle a file change (add/modify/delete).
   */
  private async handleFileChange(
    sessionName: string,
    eventsDir: string,
    filename: string
  ): Promise<void> {
    const filepath = join(eventsDir, filename);
    const key = this.eventKey(sessionName, filename);

    // Check if file still exists
    let fileStat;
    try {
      fileStat = await stat(filepath);
    } catch {
      // File deleted - cancel any scheduled event
      const active = this.activeEvents.get(key);
      if (active) {
        this.cancelEvent(key, active);
        this.activeEvents.delete(key);
        console.log(`[events] Cancelled ${key} (file deleted)`);
      }
      return;
    }

    // Parse the event file
    let config: EventConfig;
    try {
      const content = await readFile(filepath, "utf-8");
      config = JSON.parse(content) as EventConfig;
    } catch (err) {
      console.error(`[events] Failed to parse ${key}:`, err);
      return;
    }

    const event: ParsedEvent = {
      filename,
      filepath,
      sessionName,
      config,
      mtime: fileStat.mtimeMs,
    };

    // Cancel existing scheduled event if any
    const existing = this.activeEvents.get(key);
    if (existing) {
      this.cancelEvent(key, existing);
    }

    // Schedule based on type
    switch (config.type) {
      case "immediate":
        await this.handleImmediate(event);
        break;
      case "one-shot":
        this.scheduleOneShot(event);
        break;
      case "periodic":
        this.schedulePeriodic(event);
        break;
      default:
        console.error(`[events] Unknown event type in ${key}`);
    }
  }

  /**
   * Handle immediate event - execute now if file is new.
   */
  private async handleImmediate(event: ParsedEvent): Promise<void> {
    const key = this.eventKey(event.sessionName, event.filename);

    // Only execute if file was created after watcher started
    // (prevents re-executing stale immediate events on restart)
    if (event.mtime < this.startupTime) {
      console.log(`[events] Skipping stale immediate event ${key}`);
      await this.deleteEventFile(event);
      return;
    }

    console.log(`[events] Executing immediate event ${key}`);
    await this.executeEvent(event);
    await this.deleteEventFile(event);
  }

  /**
   * Schedule one-shot event for specific datetime.
   */
  private scheduleOneShot(event: ParsedEvent): void {
    const key = this.eventKey(event.sessionName, event.filename);
    const config = event.config as { type: "one-shot"; datetime: string; text: string };

    const targetTime = new Date(config.datetime).getTime();
    const now = Date.now();
    const delay = targetTime - now;

    if (delay <= 0) {
      // Past datetime - delete without executing
      console.log(`[events] Skipping past one-shot event ${key}`);
      void this.deleteEventFile(event);
      return;
    }

    console.log(`[events] Scheduling one-shot ${key} for ${config.datetime}`);

    const handle = setTimeout(async () => {
      this.activeEvents.delete(key);
      await this.executeEvent(event);
      await this.deleteEventFile(event);
    }, delay);
    handle.unref();

    this.activeEvents.set(key, {
      event,
      handle,
      handleType: "timeout",
    });
  }

  /**
   * Schedule periodic event with cron.
   */
  private schedulePeriodic(event: ParsedEvent): void {
    const key = this.eventKey(event.sessionName, event.filename);
    const config = event.config as { type: "periodic"; cron: string; timezone?: string; text: string };

    console.log(`[events] Scheduling periodic ${key} with cron: ${config.cron}`);

    try {
      const job = new Cron(config.cron, { timezone: config.timezone }, async () => {
        await this.executeEvent(event);
      });

      this.activeEvents.set(key, {
        event,
        handle: job,
        handleType: "cron",
      });
    } catch (err) {
      console.error(`[events] Invalid cron expression for ${key}:`, err);
    }
  }

  /**
   * Execute an event - wake up the session agent.
   */
  private async executeEvent(event: ParsedEvent): Promise<EventResult> {
    const key = this.eventKey(event.sessionName, event.filename);
    const startTime = Date.now();

    console.log(`[events] Executing ${key}: ${event.config.text.slice(0, 50)}...`);

    if (!this.config) {
      return {
        success: false,
        error: "Watcher not configured",
        durationMs: Date.now() - startTime,
      };
    }

    try {
      // Format the message with event marker
      const eventMarker = `[EVENT:${event.filename}:${event.config.type}]`;
      const message = `${eventMarker} ${event.config.text}`;

      // Wake up the session agent using the same manager as Slack messages
      const manager = getPiAgentManager();
      const result = await manager.prompt(event.sessionName, message);

      const responseText = result.text || "";
      const isSilent = responseText.includes("[SILENT]");

      // Send to Slack unless silent
      if (!isSilent && responseText.trim()) {
        await this.sendToSlack(event.sessionName, responseText.replace("[SILENT]", "").trim());
      }

      const execResult: EventResult = {
        success: true,
        response: responseText,
        silent: isSilent,
        durationMs: Date.now() - startTime,
      };

      console.log(
        `[events] ${key} completed in ${execResult.durationMs}ms` +
          (isSilent ? " (silent)" : "")
      );

      return execResult;
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err);
      console.error(`[events] ${key} failed:`, error);

      return {
        success: false,
        error,
        durationMs: Date.now() - startTime,
      };
    }
  }

  /**
   * Send response to Slack.
   */
  private async sendToSlack(sessionName: string, text: string): Promise<void> {
    if (!this.config) return;

    try {
      const channelId = await this.config.getSessionChannelId(sessionName);
      if (!channelId) {
        console.error(`[events] Could not resolve channel for ${sessionName}`);
        return;
      }

      await this.config.webClient.chat.postMessage({
        channel: channelId,
        text,
      });
    } catch (err) {
      console.error(`[events] Failed to send to Slack:`, err);
    }
  }

  /**
   * Delete an event file.
   */
  private async deleteEventFile(event: ParsedEvent): Promise<void> {
    try {
      await unlink(event.filepath);
    } catch (err) {
      // File might already be deleted
    }
  }

  /**
   * Cancel a scheduled event.
   */
  private cancelEvent(key: string, active: ActiveEvent): void {
    if (active.handleType === "timeout") {
      clearTimeout(active.handle as NodeJS.Timeout);
    } else {
      (active.handle as { stop: () => void }).stop();
    }
  }

  /**
   * Get status of all active events.
   */
  getStatus(): Array<{ key: string; type: string; sessionName: string }> {
    return Array.from(this.activeEvents.entries()).map(([key, active]) => ({
      key,
      type: active.event.config.type,
      sessionName: active.event.sessionName,
    }));
  }

  /**
   * Manually trigger an event file (for testing).
   */
  async triggerEvent(sessionName: string, filename: string): Promise<EventResult | null> {
    const eventsDir = join(SLACK_BASE_PATH, sessionName, EVENTS_DIR);
    const filepath = join(eventsDir, filename);

    try {
      const content = await readFile(filepath, "utf-8");
      const config = JSON.parse(content) as EventConfig;
      const fileStat = await stat(filepath);

      const event: ParsedEvent = {
        filename,
        filepath,
        sessionName,
        config,
        mtime: fileStat.mtimeMs,
      };

      return await this.executeEvent(event);
    } catch (err) {
      console.error(`[events] Failed to trigger ${sessionName}/${filename}:`, err);
      return null;
    }
  }

  /**
   * Create an event file programmatically.
   */
  async createEvent(sessionName: string, filename: string, config: EventConfig): Promise<boolean> {
    const eventsDir = join(SLACK_BASE_PATH, sessionName, EVENTS_DIR);

    try {
      // Ensure events directory exists
      await mkdir(eventsDir, { recursive: true });

      const filepath = join(eventsDir, filename.endsWith(".json") ? filename : `${filename}.json`);
      const { writeFile } = await import("node:fs/promises");
      await writeFile(filepath, JSON.stringify(config, null, 2));

      console.log(`[events] Created event ${sessionName}/${filename}`);
      return true;
    } catch (err) {
      console.error(`[events] Failed to create event:`, err);
      return false;
    }
  }
}

// Singleton instance
let watcher: EventsWatcher | null = null;

/**
 * Get the global events watcher instance.
 */
export function getEventsWatcher(): EventsWatcher {
  if (!watcher) {
    watcher = new EventsWatcher();
  }
  return watcher;
}

/**
 * Reset the global watcher (for testing).
 */
export function resetEventsWatcher(): void {
  if (watcher) {
    watcher.stop();
    watcher = null;
  }
}
