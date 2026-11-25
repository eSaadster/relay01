import { readFileSync } from "node:fs";
import { basename, join } from "node:path";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type {
  SettledSubmissionRecord,
  Submission,
  SubmissionId,
} from "@earendil-works/pi-durable";
import type { WebClient } from "@slack/web-api";
import { emitAgentEvent } from "../api/agent-events.js";
import { isAgentCommand } from "../auto-reply/agents/handler.js";
import {
  type AskResult,
  AskTimeout,
  type ChatRuntime,
  DELIVERED_KIND,
  DurableHost,
  DurableRouting,
  type DurableSetup,
  defaultStateDir,
  isFallbackFolder,
  latestAssistantText,
  PLACEHOLDER_KIND,
  readDurableFlags,
  SESSIONS_FILE,
  type SessionEntry,
  SessionMap,
  type SlackEntryData,
  type SlackTarget,
  STREAMED_FILE,
  StreamedReplies,
  sessionKey,
  type ToolActivity,
  type WaitInput,
} from "../auto-reply/durable.js";
import { recordUserIdentity } from "../auto-reply/memory-store.js";
import { formatToolName } from "../auto-reply/pi-agent.js";
import {
  setBlockRenderer,
  setUploadFunction,
} from "../auto-reply/pi-agent-tools.js";
import { splitMediaFromOutput } from "../media/parse.js";
import { formatAttachmentsPrompt } from "./attachments-prompt.js";
import { renderStepChecklist, type Step } from "./checklist.js";
import * as log from "./log.js";
import type {
  DurableIntake,
  DurableTicket,
  SlackContext,
  SlackEventInput,
  SlackFile,
} from "./slack.js";
import { splitSlackText } from "./split-message.js";
import type { Attachment } from "./store.js";

export const RESTARTED_REPLY_NOTE =
  "(I restarted partway through this reply, so here it is in full.)";
export const LOST_NOTE =
  "I restarted and lost track of a reply to this; ask again if you still need it.";
export const EVENT_KIND = "relay.event";
export const NOTE_KIND = "relay.agent-note";
export const MAX_ORPHAN_AGE_MS = 2 * 60 * 60 * 1000;
const MESSAGE_KIND = "slack.message";
const REPAIR_KIND = "relay.repair";
const STOPPED = "_Stopped_";
const GAVE_UP =
  "_I kept failing on this one after restarts, so I stopped it. Ask again if you still need it._";
const TIMED_OUT =
  "_I restarted partway through this and ran out of time on it. Ask again if you still need it._";
const REFUSED =
  "_I couldn't look up your Slack profile just now, so I can't open your session safely. Please try again in a minute._";
const FAILED = "I couldn't complete that request. Please try again.";
const LOCAL_COMMANDS = new Set([
  "stop",
  "reload clicks",
  "clicks reload",
  "reload all clicks",
  "events",
  "list events",
]);

export function isLocalCommand(text: string): boolean {
  const command = text.toLowerCase().trim();
  return (
    LOCAL_COMMANDS.has(command) ||
    command.startsWith("trigger click ") ||
    command.startsWith("trigger event ") ||
    isAgentCommand(command)
  );
}

export function channelOf(key: string): string {
  return key.split(":")[0];
}

function defined<T extends Record<string, string | undefined>>(
  value: T,
): Record<string, string> {
  return Object.fromEntries(
    Object.entries(value).filter(([, v]) => v !== undefined),
  ) as Record<string, string>;
}

export type SlackWeb = Pick<WebClient, "chat" | "files">;

export interface DurableSlackDeps {
  web: SlackWeb;
  getApiKey: (provider: string) => Promise<string | undefined>;
  setup(key: string, entry: SessionEntry): Promise<DurableSetup>;
  folderOf(event: SlackEventInput, source: "channel" | "dm"): Promise<string>;
  resolveFolder(folder: string): Promise<SlackTarget | undefined>;
  planAttachments(
    folder: string,
    files: SlackFile[],
    timestamp: string,
  ): Attachment[];
  approvalPending(folder: string): boolean;
  timeoutMs: number;
  timeoutMultiplier?: number;
  selfCorrect: boolean;
}

export interface NoteResult {
  text: string;
  silent: boolean;
  duplicate?: boolean;
}

interface Job {
  runtime: ChatRuntime;
  submission: Submission;
  requestId: string;
  folder: string;
  ahead: number;
  prompt: string;
  data: Record<string, string>;
}

interface Attempt {
  text: string;
  timedOut: boolean;
  result?: AskResult;
}

type Deliveries = { delivered: Set<string>; placeholders: Map<string, string> };

export class DurableSlack implements DurableIntake {
  private host?: DurableHost;
  private routing?: DurableRouting;
  private deps?: DurableSlackDeps;
  private streamed = new StreamedReplies(null);
  private opening = new Map<string, Promise<ChatRuntime>>();
  private inflight = new Set<string>();
  private delivering = new Set<string>();
  private limited = new Set<SubmissionId>();
  private stopped = new Set<SubmissionId>();
  private owners = new Map<string, string>();

  constructor(
    readonly flags: ReadonlySet<string>,
    readonly stateDir: string = defaultStateDir(),
  ) {}

  static fromEnv(
    options: { slackBase?: string; stateDir?: string } = {},
  ): DurableSlack | undefined {
    const flags = readDurableFlags(options.slackBase);
    const stateDir = options.stateDir ?? defaultStateDir();
    const known = new SessionMap(join(stateDir, SESSIONS_FILE)).keys();
    if (flags.size === 0 && known.length === 0) return undefined;
    return new DurableSlack(flags, stateDir);
  }

  get sessions(): DurableHost["sessions"] | undefined {
    return this.host?.sessions;
  }

  async start(deps: DurableSlackDeps): Promise<void> {
    this.deps = deps;
    this.streamed = new StreamedReplies(join(this.stateDir, STREAMED_FILE));
    const host = await DurableHost.open({
      getApiKey: deps.getApiKey,
      stateDir: this.stateDir,
      onResumeLimit: (_key, record) => this.limited.add(record.id),
    });
    this.host = host;
    this.routing = new DurableRouting(this.flags, host.sessions);
    const pending = await host.pending();
    const keys = host.sessions.keys();
    for (const key of keys) {
      try {
        await this.attach(key, pending.get(key));
      } catch (err) {
        console.error(`[durable ${key}] Could not re-attach: ${err}`);
      }
    }
    for (const key of keys) {
      if (!host.runtimes.has(key)) continue;
      try {
        await this.deliverUndelivered(key);
      } catch (err) {
        console.error(
          `[durable ${key}] Could not deliver unsent replies: ${err}`,
        );
      }
    }
    await host.resume();
    const interrupted = [...pending.values()].reduce((n, s) => n + s.size, 0);
    console.log(
      `[durable] Ready: ${keys.length} conversation(s), ${interrupted} interrupted input(s); flagged: ${[...this.flags].join(", ") || "none"}`,
    );
  }

  async close() {
    await this.host?.close();
  }

  async intake(
    event: SlackEventInput,
    source: "channel" | "dm",
  ): Promise<DurableTicket | undefined> {
    const host = this.host;
    const deps = this.deps;
    if (!host || !deps || !this.routing) return undefined;
    const started = Date.now();
    const text = event.text.replace(/<@[A-Z0-9]+>/gi, "").trim();
    if (isLocalCommand(text)) return undefined;
    const isDm = source === "dm";
    const key = sessionKey({ channel: event.channel, user: event.user, isDm });
    const known = host.sessions.get(key);
    let folder = known?.folder;
    if (!folder) {
      if (!this.mayBeFlagged(isDm)) return undefined;
      folder = await deps.folderOf(event, source);
      const route = this.routing.route({
        channel: event.channel,
        user: event.user,
        isDm,
        folder,
      });
      if (route === "legacy") return undefined;
      if (route === "refused") {
        console.error(
          `[durable ${key}] ${folder} has no stable identity; replying without a session`,
        );
        return { run: (ctx) => ctx.respond(REFUSED) };
      }
    }
    const requestId = `${event.channel}:${event.ts}`;
    if (this.inflight.has(requestId)) return {};
    this.inflight.add(requestId);
    let handed = false;
    try {
      const runtime = await this.open({
        channel: event.channel,
        user: event.user,
        isDm,
        folder,
      });
      const entry = host.sessions.get(key);
      if (!entry) throw new Error(`No durable session for ${key}`);
      if (await host.existing(entry.conversationId, requestId)) {
        console.log(
          `[durable ${key}] ${requestId} was already submitted; ignoring the redelivery`,
        );
        return {};
      }
      const attachments = deps.planAttachments(
        entry.folder,
        event.files ?? [],
        event.ts,
      );
      const data = defined({
        channel: event.channel,
        threadTs: isDm ? event.thread_ts : (event.thread_ts ?? event.ts),
        user: event.user,
        source,
      });
      const submission = await runtime.submit({
        text: text + formatAttachmentsPrompt(attachments),
        entry: { kind: MESSAGE_KIND, data: data as unknown as SlackEntryData },
        requestId,
      });
      const ahead = await runtime.position(submission.id);
      console.log(
        `[durable ${key}] Submitted ${requestId} ${Date.now() - started}ms after ack${ahead ? `; queued behind ${ahead}` : ""}`,
      );
      handed = true;
      const job: Job = {
        runtime,
        submission,
        requestId,
        folder: entry.folder,
        ahead,
        prompt: text,
        data,
      };
      return {
        folder: entry.folder,
        run: (ctx) =>
          this.reply(ctx, job).finally(() => this.inflight.delete(requestId)),
      };
    } catch (err) {
      console.error(`[durable ${key}] Could not submit ${requestId}: ${err}`);
      return { run: (ctx) => ctx.respond(`_Error: ${String(err)}_`) };
    } finally {
      if (!handed) this.inflight.delete(requestId);
    }
  }

  async stop(target: {
    channel: string;
    user?: string;
    isDm: boolean;
  }): Promise<"stopped" | "idle" | undefined> {
    const host = this.host;
    if (!host) return undefined;
    let key: string;
    try {
      key = sessionKey(target);
    } catch {
      return undefined;
    }
    if (!host.sessions.get(key)) return undefined;
    const runtime = host.runtimes.get(key);
    if (!runtime?.busy) return "idle";
    for (const id of runtime.currentInputs()) this.stopped.add(id);
    await runtime.stopCurrentRun();
    return "stopped";
  }

  async note(
    folder: string,
    input: { kind: string; text: string; requestId: string },
  ): Promise<NoteResult | undefined> {
    const host = this.host;
    const deps = this.deps;
    if (!host || !deps) return undefined;
    let key = host.keyOfFolder(folder);
    let target: SlackTarget | undefined;
    if (key) {
      const entry = host.sessions.get(key);
      if (entry)
        target = {
          channel: channelOf(key),
          user: entry.userId,
          isDm: entry.isDm,
          folder: entry.folder,
        };
    } else {
      if (!this.flags.has(folder) || isFallbackFolder(folder)) return undefined;
      target = await deps.resolveFolder(folder);
      if (!target) {
        console.error(
          `[durable] Could not resolve ${folder}; running ${input.requestId} on the legacy path`,
        );
        return undefined;
      }
      key = sessionKey(target);
    }
    if (!target) return undefined;
    const runtime = await this.open(target);
    const entry = host.sessions.get(key);
    if (!entry) return undefined;
    if (await host.existing(entry.conversationId, input.requestId))
      return { text: "", silent: false, duplicate: true };
    const channel = channelOf(key);
    const submission = await runtime.submit({
      text: input.text,
      entry: {
        kind: input.kind,
        data: { channel, source: entry.isDm ? "dm" : "channel" },
      },
      requestId: input.requestId,
    });
    const { text } = await this.attempt(runtime, submission, {
      timeoutMs: deps.timeoutMs,
      isPaused: () => deps.approvalPending(entry.folder),
    });
    const isEvent = input.kind === EVENT_KIND;
    const silent = isEvent && text.includes("[SILENT]");
    const body = isEvent ? text.replace("[SILENT]", "").trim() : text;
    let ts: string | undefined;
    if (!silent && body.trim())
      ts = (await deps.web.chat.postMessage({ channel, text: body })).ts;
    await this.markDelivered(runtime, input.requestId, ts);
    return { text, silent };
  }

  private ready(): DurableHost {
    if (!this.host) throw new Error("The durable host is not open");
    return this.host;
  }

  private mayBeFlagged(isDm: boolean): boolean {
    const prefix = isDm ? "@" : "#";
    return [...this.flags].some((folder) => folder.startsWith(prefix));
  }

  private attach(
    key: string,
    orphans?: Set<SubmissionId>,
  ): Promise<ChatRuntime> {
    const host = this.ready();
    const deps = this.deps;
    const entry = host.sessions.get(key);
    if (!deps || !entry) throw new Error(`No durable session for ${key}`);
    return deps.setup(key, entry).then((setup) =>
      host.attach(
        key,
        setup,
        orphans ?? new Set(),
        (record, text) => void this.deliverSettled(key, record, text),
        {
          timeoutMs: deps.timeoutMs,
          isPaused: () => deps.approvalPending(entry.folder),
        },
      ),
    );
  }

  private open(target: SlackTarget): Promise<ChatRuntime> {
    const host = this.ready();
    const key = sessionKey(target);
    const live = host.runtimes.get(key);
    if (live) return Promise.resolve(live);
    const opening = this.opening.get(key);
    if (opening) return opening;
    const created = (async () => {
      const known = host.sessions.get(key);
      const { entry } = await host.ensureSession(target);
      if (!known) {
        console.log(
          `[durable ${key}] Created conversation ${entry.conversationId} for ${entry.folder}`,
        );
        if (entry.isDm && entry.userId)
          void recordUserIdentity(entry.userId, entry.folder.slice(1)).catch(
            () => {},
          );
      }
      return this.attach(key);
    })().finally(() => this.opening.delete(key));
    this.opening.set(key, created);
    return created;
  }

  private async attempt(
    runtime: ChatRuntime,
    submission: Submission,
    input: WaitInput,
  ): Promise<Attempt> {
    try {
      const result = await runtime.wait(submission, input);
      return { text: result.text, timedOut: false, result };
    } catch (err) {
      if (!(err instanceof AskTimeout)) throw err;
      return { text: latestAssistantText(err.messages), timedOut: true };
    }
  }

  private async reply(ctx: SlackContext, job: Job): Promise<void> {
    const deps = this.deps;
    if (!deps) return;
    const { runtime, requestId, folder } = job;
    const logCtx = {
      channelId: ctx.message.channel,
      userName: ctx.message.userName,
      channelName: ctx.channelName,
    };
    log.logUserMessage(logCtx, ctx.message.text);
    const steps: Step[] = [];
    const starts = new Map<string, number>();
    const failures: Record<"primary" | "repair", ToolActivity[]> = {
      primary: [],
      repair: [],
    };
    let seq = 0;
    const upload = async (filePath: string, title?: string) => {
      this.streamed.add(requestId);
      await ctx.uploadFile(filePath, title);
    };
    const render = async (blocks: unknown[], text: string) => {
      this.streamed.add(requestId);
      await ctx.respondBlocks(blocks, text);
    };
    const watch = (
      attempt: "primary" | "repair",
      timeoutMs: number,
    ): WaitInput => ({
      timeoutMs,
      isPaused: () => deps.approvalPending(folder),
      onStart: () => {
        this.owners.set(folder, requestId);
        setUploadFunction(folder, upload);
        setBlockRenderer(folder, render);
      },
      onToolActivity: (activity) => {
        const label = formatToolName(activity.toolName);
        if (activity.phase === "start") {
          steps.push({ label, state: "run" });
          starts.set(activity.toolCallId, Date.now());
        } else {
          const step = [...steps]
            .reverse()
            .find((s) => s.label === label && s.state === "run");
          if (step) step.state = activity.isError ? "err" : "ok";
          if (activity.isError) failures[attempt].push(activity);
        }
        emitAgentEvent({
          session: folder,
          seq: seq++,
          phase: activity.phase,
          toolName: activity.toolName,
          label,
          isError: activity.isError,
          durationMs:
            activity.phase === "end"
              ? Date.now() - (starts.get(activity.toolCallId) ?? Date.now())
              : undefined,
          ts: Date.now(),
        });
        void ctx.replaceMessage(renderStepChecklist(steps)).catch(() => {});
      },
    });
    let retried = false;
    try {
      if (job.ahead > 0)
        await ctx.replaceMessage(
          `_Queued behind ${job.ahead} message${job.ahead === 1 ? "" : "s"}_`,
        );
      else await ctx.setTyping(true);
      await ctx.setWorking(true);
      const placeholder = ctx.placeholderTs();
      if (placeholder)
        await runtime.record(PLACEHOLDER_KIND, { requestId, ts: placeholder });

      const primary = await this.attempt(
        runtime,
        job.submission,
        watch("primary", deps.timeoutMs),
      );
      let text = primary.text;
      const unanswered = primary.result?.unanswered;
      if (unanswered) {
        text =
          unanswered.reason === "aborted"
            ? STOPPED
            : `_Error: ${unanswered.reason}_`;
      } else if (
        primary.timedOut ||
        failures.primary.length > 0 ||
        !text.trim()
      ) {
        if (deps.selfCorrect) {
          retried = true;
          text = await this.repair(job, primary, failures, watch);
        } else if (primary.timedOut) throw new Error("Agent timeout");
      }

      const { text: cleaned, mediaUrls } = splitMediaFromOutput(text || "");
      if (cleaned) await ctx.respond(cleaned);
      else if (!mediaUrls?.length && !ctx.hasRenderedBlocks())
        await ctx.respond("_(No response from agent)_");
      for (const mediaPath of mediaUrls ?? []) {
        try {
          await ctx.uploadFile(mediaPath);
          log.logResponse(logCtx, `[Uploaded media: ${mediaPath}]`);
        } catch (err) {
          log.logAgentError(
            logCtx,
            `Failed to upload media ${mediaPath}: ${err}`,
          );
        }
      }
      log.logResponse(logCtx, cleaned || "(empty)");
      await ctx.setWorking(false);
      await this.markDelivered(
        runtime,
        requestId,
        ctx.placeholderTs(),
        retried ? [`${requestId}:retry`] : [],
      );
    } catch (err) {
      log.logAgentError(logCtx, String(err));
      try {
        await ctx.respond(`_Error: ${String(err)}_`);
        await ctx.setWorking(false);
        await this.markDelivered(
          runtime,
          requestId,
          ctx.placeholderTs(),
          retried ? [`${requestId}:retry`] : [],
        );
      } catch (inner) {
        console.error(
          `[durable ${folder}] Could not post the reply to ${requestId}: ${inner}`,
        );
      }
    } finally {
      if (this.owners.get(folder) === requestId) {
        this.owners.delete(folder);
        setUploadFunction(folder, null);
        setBlockRenderer(folder, null);
      }
    }
  }

  private async repair(
    job: Job,
    primary: Attempt,
    failures: Record<"primary" | "repair", ToolActivity[]>,
    watch: (attempt: "primary" | "repair", timeoutMs: number) => WaitInput,
  ): Promise<string> {
    const deps = this.deps;
    if (!deps) return FAILED;
    const timeoutMs = primary.timedOut
      ? Math.round(deps.timeoutMs * (deps.timeoutMultiplier ?? 2))
      : deps.timeoutMs;
    const failed = failures.primary
      .map((f) => `- ${f.toolName} (${f.toolCallId})`)
      .join("\n");
    const instruction = [
      primary.timedOut
        ? "The previous attempt timed out before completing."
        : "The previous attempt failed due to tool errors or an empty response.",
      `User message:\n${job.prompt}`,
      ...(failed ? [`Failures:\n${failed}`] : []),
      "Retry only the failed tool calls and return a final answer.",
    ].join("\n\n");
    try {
      const submission = await job.runtime.submit({
        text: instruction,
        entry: { kind: REPAIR_KIND, data: job.data },
        requestId: `${job.requestId}:retry`,
      });
      const repair = await this.attempt(
        job.runtime,
        submission,
        watch("repair", timeoutMs),
      );
      const ok =
        !repair.timedOut &&
        !repair.result?.unanswered &&
        failures.repair.length === 0 &&
        repair.text.trim().length > 0;
      return ok ? repair.text : FAILED;
    } catch {
      return FAILED;
    }
  }

  private async markDelivered(
    runtime: ChatRuntime,
    requestId: string,
    ts: string | undefined,
    also: string[] = [],
  ) {
    for (const id of [requestId, ...also])
      await runtime.record(DELIVERED_KIND, defined({ requestId: id, ts }));
    this.streamed.delete(requestId);
  }

  private async deliverUndelivered(key: string) {
    const host = this.ready();
    const entry = host.sessions.get(key);
    if (!entry) return;
    const settled = (await host.settledInputs(entry.conversationId)).filter(
      (r) => r.requestId && r.entry,
    );
    if (settled.length === 0) return;
    const from = settled
      .map((r) => r.entry as NonNullable<typeof r.entry>)
      .reduce((a, b) => (b < a ? b : a));
    const known = await host.deliveries(entry.conversationId, from);
    const retried = new Set(
      settled
        .map((r) => r.requestId as string)
        .filter((id) => id.endsWith(":retry"))
        .map((id) => id.slice(0, -":retry".length)),
    );
    for (const record of settled.reverse()) {
      const requestId = record.requestId as string;
      if (known.delivered.has(requestId) || retried.has(requestId)) continue;
      await this.deliverSettled(key, record, "", known);
    }
  }

  private async answerText(record: SettledSubmissionRecord): Promise<string> {
    if (record.status !== "done" || record.answer === undefined) return "";
    const answer = await this.ready().entry(record.answer);
    return latestAssistantText((answer?.model ?? []) as AgentMessage[]);
  }

  private unansweredText(record: SettledSubmissionRecord): string {
    if (record.status !== "unanswered") return "";
    if (this.limited.has(record.id)) return GAVE_UP;
    if (this.stopped.has(record.id)) return STOPPED;
    if (record.reason === "aborted") return TIMED_OUT;
    return `_I couldn't finish this reply (${record.reason})._`;
  }

  private async deliverSettled(
    key: string,
    record: SettledSubmissionRecord,
    liveText: string,
    known?: Deliveries,
  ) {
    const requestId = record.requestId;
    if (!requestId || !record.entry || this.delivering.has(requestId)) return;
    this.delivering.add(requestId);
    try {
      const host = this.ready();
      const deps = this.deps;
      const runtime = host.runtimes.get(key);
      const input = await host.entry(record.entry);
      const data = input?.data as Partial<SlackEntryData> | undefined;
      if (!deps || !runtime || !input || typeof data?.channel !== "string") {
        console.error(
          `[durable ${key}] Cannot deliver ${requestId}: no delivery target`,
        );
        return;
      }
      const { delivered, placeholders } =
        known ?? (await host.deliveries(runtime.conversation.id, record.entry));
      if (delivered.has(requestId)) return;
      const base = requestId.endsWith(":retry")
        ? requestId.slice(0, -":retry".length)
        : requestId;
      const also = base === requestId ? [] : [base];
      const fromSlack =
        input.kind === MESSAGE_KIND || input.kind === REPAIR_KIND;
      const sentAt = fromSlack
        ? Number(base.slice(base.indexOf(":") + 1)) * 1000
        : ((input.model?.[0] as { timestamp?: number } | undefined)
            ?.timestamp ?? Date.now());
      const placeholder = placeholders.get(base);
      let text =
        record.status === "done"
          ? liveText || (await this.answerText(record))
          : this.unansweredText(record);
      if (input.kind === EVENT_KIND && text.includes("[SILENT]")) text = "";
      if (input.kind === EVENT_KIND) text = text.replace("[SILENT]", "").trim();
      if (Date.now() - sentAt > MAX_ORPHAN_AGE_MS) {
        console.log(
          `[durable ${key}] ${requestId} is older than ${MAX_ORPHAN_AGE_MS / 60000} minutes; not delivering it`,
        );
        text = fromSlack ? LOST_NOTE : "";
      } else if (this.streamed.has(base) && text.trim()) {
        text = `${RESTARTED_REPLY_NOTE}\n\n${text}`;
      }
      if (!text.trim()) {
        await this.markDelivered(runtime, requestId, undefined, also);
        return;
      }
      const { text: cleaned, mediaUrls } = splitMediaFromOutput(text);
      const channel = data.channel;
      const chunks = splitSlackText(cleaned || "_(see attached)_");
      let ts = placeholder;
      if (placeholder)
        await deps.web.chat.update({
          channel,
          ts: placeholder,
          text: chunks[0],
        });
      else
        ts = (
          await deps.web.chat.postMessage({
            channel,
            text: chunks[0],
            ...(data.threadTs ? { thread_ts: data.threadTs } : {}),
          })
        ).ts;
      for (const chunk of chunks.slice(1))
        await deps.web.chat.postMessage({
          channel,
          text: chunk,
          ...(ts ? { thread_ts: ts } : {}),
        });
      for (const mediaPath of mediaUrls ?? []) {
        try {
          const upload = {
            channel_id: channel,
            file: readFileSync(mediaPath),
            filename: basename(mediaPath),
            title: basename(mediaPath),
          };
          await deps.web.files.uploadV2(
            data.threadTs ? { ...upload, thread_ts: data.threadTs } : upload,
          );
        } catch (err) {
          console.error(
            `[durable ${key}] Could not upload ${mediaPath} for ${requestId}: ${err}`,
          );
        }
      }
      await this.markDelivered(runtime, requestId, ts, also);
      this.streamed.delete(base);
      console.log(
        `[durable ${key}] Delivered ${requestId} after a restart${placeholder ? " (updated its placeholder)" : ""}`,
      );
    } catch (err) {
      console.error(`[durable ${key}] Could not deliver ${requestId}: ${err}`);
    } finally {
      this.delivering.delete(requestId);
    }
  }
}
