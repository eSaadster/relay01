// Click scheduler - manages timers for all clicks

import { Cron } from "croner";

import { logVerbose } from "../../globals.js";
import { sendClickAlert } from "./alerts.js";
import { discoverClicks } from "./discovery.js";
import { executeClick } from "./runner.js";
import type {
  ClickConfig,
  ClickContext,
  ClickResult,
  ClickSchedulerConfig,
} from "./types.js";

/**
 * Manages scheduled click execution across all sessions.
 */
type ClickScheduleHandle =
  | { type: "interval"; handle: NodeJS.Timeout }
  | { type: "cron"; handle: Cron };

export class ClickScheduler {
  private schedules = new Map<string, ClickScheduleHandle>();
  private isRunning = new Map<string, boolean>();
  private config: ClickSchedulerConfig | null = null;
  private started = false;

  /**
   * Generate a unique key for a click.
   */
  private makeKey(sessionName: string, clickId: string): string {
    return `${sessionName}:${clickId}`;
  }

  /**
   * Start the scheduler - discovers all clicks and schedules them.
   */
  async start(config: ClickSchedulerConfig): Promise<void> {
    if (this.started) {
      console.warn("[clicks] Scheduler already started");
      return;
    }

    this.config = config;
    this.started = true;

    console.log("[clicks] Starting click scheduler...");

    const discovered = await discoverClicks();

    // Schedule project-level clicks
    if (discovered.projectClicks) {
      const { config: clicksConfig, context } = discovered.projectClicks;
      for (const click of clicksConfig.clicks) {
        if (click.enabled !== false) {
          this.scheduleClick(context, click);
        }
      }
    }

    // Schedule session clicks
    for (const { config: clicksConfig, context } of discovered.sessionClicks) {
      for (const click of clicksConfig.clicks) {
        if (click.enabled !== false) {
          this.scheduleClick(context, click);
        }
      }
    }

    const totalScheduled = this.schedules.size;
    console.log(`[clicks] Scheduler started with ${totalScheduled} clicks`);
  }

  /**
   * Stop the scheduler - clears all timers.
   */
  stop(): void {
    console.log("[clicks] Stopping click scheduler...");

    for (const [key, schedule] of this.schedules) {
      if (schedule.type === "interval") {
        clearInterval(schedule.handle);
      } else {
        schedule.handle.stop();
      }
      logVerbose(`Cleared schedule for ${key}`);
    }

    this.schedules.clear();
    this.isRunning.clear();
    this.started = false;

    console.log("[clicks] Scheduler stopped");
  }

  /**
   * Reload clicks configuration.
   * Optionally specify a session to reload only that session's clicks.
   */
  async reload(sessionName?: string): Promise<void> {
    if (!this.config) {
      console.warn("[clicks] Cannot reload - scheduler not started");
      return;
    }

    console.log(
      `[clicks] Reloading ${sessionName ? `clicks for ${sessionName}` : "all clicks"}...`
    );

    // Clear existing timers for the specified session (or all)
    for (const [key, schedule] of this.schedules) {
      if (!sessionName || key.startsWith(`${sessionName}:`)) {
        if (schedule.type === "interval") {
          clearInterval(schedule.handle);
        } else {
          schedule.handle.stop();
        }
        this.schedules.delete(key);
        this.isRunning.delete(key);
      }
    }

    // Re-discover and schedule
    const discovered = await discoverClicks();

    if (!sessionName) {
      // Reload everything
      if (discovered.projectClicks) {
        const { config: clicksConfig, context } = discovered.projectClicks;
        for (const click of clicksConfig.clicks) {
          if (click.enabled !== false) {
            this.scheduleClick(context, click);
          }
        }
      }

      for (const { config: clicksConfig, context } of discovered.sessionClicks) {
        for (const click of clicksConfig.clicks) {
          if (click.enabled !== false) {
            this.scheduleClick(context, click);
          }
        }
      }
    } else {
      // Reload specific session
      const sessionClicks = discovered.sessionClicks.find(
        (s) => s.sessionName === sessionName
      );
      if (sessionClicks) {
        for (const click of sessionClicks.config.clicks) {
          if (click.enabled !== false) {
            this.scheduleClick(sessionClicks.context, click);
          }
        }
      }
    }

    console.log(`[clicks] Reload complete, ${this.schedules.size} clicks scheduled`);
  }

  /**
   * Clear an existing schedule for a click.
   */
  private clearSchedule(key: string): void {
    const existing = this.schedules.get(key);
    if (!existing) return;

    if (existing.type === "interval") {
      clearInterval(existing.handle);
    } else {
      existing.handle.stop();
    }

    this.schedules.delete(key);
  }

  /**
   * Schedule a single click.
   */
  private scheduleClick(ctx: ClickContext, click: ClickConfig): void {
    const key = this.makeKey(ctx.sessionName, click.id);

    this.clearSchedule(key);

    if (click.cron) {
      const timezone = click.timezone;
      logVerbose(
        `Scheduling click ${key}: cron "${click.cron}"` +
          (timezone ? ` (${timezone})` : "")
      );

      try {
        const job = new Cron(click.cron, { timezone }, () => {
          void this.runClick(ctx, click);
        });

        this.schedules.set(key, { type: "cron", handle: job });
      } catch (err) {
        console.error(`[clicks] Invalid cron for ${key}:`, err);
      }
      return;
    }

    if (!click.intervalMinutes) {
      console.warn(`[clicks] Click ${key} has no schedule configured, skipping`);
      return;
    }

    const intervalMs = click.intervalMinutes * 60 * 1000;

    logVerbose(
      `Scheduling click ${key}: every ${click.intervalMinutes} minutes`
    );

    // Schedule with setInterval, use .unref() so it doesn't keep process alive
    const timer = setInterval(() => {
      void this.runClick(ctx, click);
    }, intervalMs);
    timer.unref();

    this.schedules.set(key, { type: "interval", handle: timer });
  }

  /**
   * Execute a click (called by timer).
   */
  private async runClick(ctx: ClickContext, click: ClickConfig): Promise<void> {
    const key = this.makeKey(ctx.sessionName, click.id);

    // Prevent concurrent executions
    if (this.isRunning.get(key)) {
      logVerbose(`Click ${key} already running, skipping`);
      return;
    }

    this.isRunning.set(key, true);

    try {
      const result = await executeClick(ctx, click);

      if (result.shouldAlert) {
        await this.sendAlert(ctx, click, result);
      }
    } catch (err) {
      console.error(`[clicks] Error running ${key}:`, err);
    } finally {
      this.isRunning.set(key, false);
    }
  }

  /**
   * Send an alert for a click result.
   */
  private async sendAlert(
    ctx: ClickContext,
    click: ClickConfig,
    result: ClickResult
  ): Promise<void> {
    if (!this.config) {
      console.error("[clicks] Cannot send alert - scheduler not configured");
      return;
    }

    try {
      await sendClickAlert(this.config, ctx, click, result);
    } catch (err) {
      console.error(
        `[clicks] Failed to send alert for ${click.id}: ${err}`
      );
    }
  }

  /**
   * Manually trigger a click execution (for testing).
   */
  async triggerClick(sessionName: string, clickId: string): Promise<ClickResult | null> {
    const discovered = await discoverClicks();

    // Find the click
    let ctx: ClickContext | undefined;
    let click: ClickConfig | undefined;

    if (sessionName === "project" && discovered.projectClicks) {
      ctx = discovered.projectClicks.context;
      click = discovered.projectClicks.config.clicks.find(
        (c) => c.id === clickId
      );
    } else {
      const session = discovered.sessionClicks.find(
        (s) => s.sessionName === sessionName
      );
      if (session) {
        ctx = session.context;
        click = session.config.clicks.find((c) => c.id === clickId);
      }
    }

    if (!ctx || !click) {
      console.error(
        `[clicks] Click ${clickId} not found for session ${sessionName}`
      );
      return null;
    }

    return executeClick(ctx, click);
  }

  /**
   * Get status of all scheduled clicks.
   */
  getStatus(): Array<{ key: string; running: boolean }> {
    const status: Array<{ key: string; running: boolean }> = [];

    for (const key of this.schedules.keys()) {
      status.push({
        key,
        running: this.isRunning.get(key) || false,
      });
    }

    return status;
  }
}

// Singleton instance
let scheduler: ClickScheduler | null = null;

/**
 * Get the global click scheduler instance.
 */
export function getClickScheduler(): ClickScheduler {
  if (!scheduler) {
    scheduler = new ClickScheduler();
  }
  return scheduler;
}

/**
 * Reset the global scheduler (for testing).
 */
export function resetClickScheduler(): void {
  if (scheduler) {
    scheduler.stop();
    scheduler = null;
  }
}
