// Human-in-the-loop write approval gate.
//
// Tool calls matching a configured rule pause until a human clicks Approve or
// Deny on a Block Kit message in the session's channel (or a timeout denies
// them). Reads never pause — only calls matching approvals.json rules.
//
// Config resolution (first match wins):
//   ~/relay01/slack/<session>/approvals.json   session-specific
//   ~/relay01/slack/approvals.json             global
// No config file → nothing is gated.
//
// approvals.json shape:
//   {
//     "rules": ["mcp:linear:*create*", "mcp:notion:*", "bash"],
//     "timeoutSeconds": 300
//   }
// Rules match a canonical call descriptor: plain tools by name (e.g. "bash",
// "write_file"); MCP calls as "mcp:<server>:<tool>". "*" wildcards allowed.

import fsSync from "node:fs";
import path from "node:path";
import type { WebClient } from "@slack/web-api";
import { SLACK_BASE_PATH } from "./pi-agent-tools.js";

export interface ApprovalConfig {
  rules: string[];
  timeoutSeconds: number;
}

export interface ApprovalOutcome {
  approved: boolean;
  by?: string; // display name of the approver
  timedOut?: boolean;
}

const DEFAULT_TIMEOUT_SECONDS = 300;

/** Load the approval config for a session, or null when nothing is gated. */
export function loadApprovalConfig(sessionName: string): ApprovalConfig | null {
  const candidates = [
    path.join(SLACK_BASE_PATH, sessionName, "approvals.json"),
    path.join(SLACK_BASE_PATH, "approvals.json"),
  ];
  for (const file of candidates) {
    try {
      if (!fsSync.existsSync(file)) continue;
      const raw = JSON.parse(fsSync.readFileSync(file, "utf8"));
      const rules = Array.isArray(raw.rules) ? raw.rules.filter((r: unknown) => typeof r === "string") : [];
      if (rules.length === 0) return null;
      return {
        rules,
        timeoutSeconds: typeof raw.timeoutSeconds === "number" && raw.timeoutSeconds > 0
          ? raw.timeoutSeconds
          : DEFAULT_TIMEOUT_SECONDS,
      };
    } catch (err) {
      console.warn(`[approvals] Failed to load ${file}: ${err}`);
    }
  }
  return null;
}

/** Glob-ish rule match: "*" matches any run of characters, case-insensitive. */
export function matchesRule(descriptor: string, rule: string): boolean {
  const pattern = "^" + rule.split("*").map((s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join(".*") + "$";
  return new RegExp(pattern, "i").test(descriptor);
}

/** True when any configured rule matches the call descriptor. */
export function requiresApproval(config: ApprovalConfig | null, descriptor: string): boolean {
  return !!config && config.rules.some((r) => matchesRule(descriptor, r));
}

/** Canonical descriptor for a tool call ("bash", "mcp:linear:create_issue", …). */
export function callDescriptor(toolName: string, params: Record<string, unknown> | undefined): string {
  const name = toolName.toLowerCase();
  if (name === "mcp" && params?.action === "call") {
    return `mcp:${params.server ?? "?"}:${params.tool ?? "?"}`;
  }
  return name;
}

interface PendingApproval {
  resolve: (outcome: ApprovalOutcome) => void;
  sessionName: string;
  channel: string;
  ts: string;
  summary: string;
  timer: NodeJS.Timeout;
}

export interface ApprovalManagerConfig {
  webClient: WebClient;
  getSessionChannelId: (sessionName: string) => Promise<string | undefined>;
}

const ACTION_PREFIX = "appr";

export class ApprovalManager {
  private config: ApprovalManagerConfig | null = null;
  private pending = new Map<string, PendingApproval>();
  private counter = 0;

  configure(config: ApprovalManagerConfig): void {
    this.config = config;
  }

  /** True when the Slack side is wired up and approvals can be requested. */
  isConfigured(): boolean {
    return this.config !== null;
  }

  /**
   * Post an approve/deny prompt for a gated call and wait for the outcome.
   * Denies on timeout or when the session's channel can't be resolved.
   */
  async requestApproval(args: {
    sessionName: string;
    descriptor: string;
    summary: string; // human-readable description of the call (label + args)
    timeoutSeconds: number;
  }): Promise<ApprovalOutcome> {
    if (!this.config) {
      console.warn("[approvals] Not configured; denying gated call");
      return { approved: false };
    }
    const channel = await this.config.getSessionChannelId(args.sessionName);
    if (!channel) {
      console.warn(`[approvals] Cannot resolve channel for ${args.sessionName}; denying gated call`);
      return { approved: false };
    }

    const id = `${Date.now().toString(36)}_${this.counter++}`;
    const blocks = [
      {
        type: "section",
        text: {
          type: "mrkdwn",
          text: `:lock: *Approval required*\n${args.summary.slice(0, 2800)}`,
        },
      },
      {
        type: "context",
        elements: [{ type: "mrkdwn", text: `\`${args.descriptor}\` — auto-denies in ${Math.round(args.timeoutSeconds / 60)} min` }],
      },
      {
        type: "actions",
        elements: [
          {
            type: "button",
            text: { type: "plain_text", text: "Approve" },
            style: "primary",
            action_id: `${ACTION_PREFIX}:${id}:ok`,
          },
          {
            type: "button",
            text: { type: "plain_text", text: "Deny" },
            style: "danger",
            action_id: `${ACTION_PREFIX}:${id}:no`,
          },
        ],
      },
    ];

    const posted = await this.config.webClient.chat.postMessage({
      channel,
      text: `Approval required: ${args.descriptor}`,
      blocks: blocks as any,
    });
    const ts = posted.ts as string;

    return new Promise<ApprovalOutcome>((resolve) => {
      const timer = setTimeout(() => {
        this.finish(id, { approved: false, timedOut: true });
      }, args.timeoutSeconds * 1000);
      this.pending.set(id, { resolve, sessionName: args.sessionName, channel, ts, summary: args.summary, timer });
    });
  }

  /**
   * True when a session has an approval waiting on a human. Used to pause the
   * agent run timeout so a slow decision doesn't kill the run.
   */
  hasPendingForSession(sessionName: string): boolean {
    for (const p of this.pending.values()) {
      if (p.sessionName === sessionName) return true;
    }
    return false;
  }

  /**
   * Handle a block_actions click. Returns true when the action belonged to a
   * pending approval (so callers can ignore unrelated actions).
   */
  async handleAction(actionId: string, userName: string): Promise<boolean> {
    const match = actionId.match(new RegExp(`^${ACTION_PREFIX}:(.+):(ok|no)$`));
    if (!match) return false;
    const [, id, verdict] = match;
    if (!this.pending.has(id)) return true; // ours, but already resolved
    await this.finish(id, { approved: verdict === "ok", by: userName });
    return true;
  }

  private async finish(id: string, outcome: ApprovalOutcome): Promise<void> {
    const p = this.pending.get(id);
    if (!p) return;
    this.pending.delete(id);
    clearTimeout(p.timer);

    const status = outcome.approved
      ? `:white_check_mark: *Approved*${outcome.by ? ` by ${outcome.by}` : ""}`
      : outcome.timedOut
        ? ":hourglass: *Denied* (timed out)"
        : `:no_entry: *Denied*${outcome.by ? ` by ${outcome.by}` : ""}`;
    try {
      await this.config!.webClient.chat.update({
        channel: p.channel,
        ts: p.ts,
        text: status.replace(/[:*]/g, ""),
        blocks: [
          { type: "section", text: { type: "mrkdwn", text: `:lock: ${p.summary.slice(0, 2800)}` } },
          { type: "context", elements: [{ type: "mrkdwn", text: status }] },
        ] as any,
      });
    } catch (err) {
      console.warn(`[approvals] Failed to update approval message: ${err}`);
    }
    p.resolve(outcome);
  }
}

let managerInstance: ApprovalManager | null = null;

export function getApprovalManager(): ApprovalManager {
  if (!managerInstance) managerInstance = new ApprovalManager();
  return managerInstance;
}
