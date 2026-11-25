import {
  chmodSync,
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { BACKGROUND_CONTEXT, withCancel } from "@earendil-works/chord/context";
import type { AgentMessage, AgentTool } from "@earendil-works/pi-agent-core";
import type {
  Api,
  ImageContent,
  Message,
  Model,
  ProviderHeaders,
  TextContent,
} from "@earendil-works/pi-ai";
import { stream, streamSimple } from "@earendil-works/pi-ai/compat";
import {
  createModels,
  createProvider,
  type MutableModels,
} from "@earendil-works/pi-ai/models";
import {
  type AgentEvent,
  type AgentEventStream,
  type Conversation,
  type ConversationId,
  type Cursor,
  createRegistry,
  defineDoc,
  defineExtension,
  defineTool,
  type EntryId,
  type EntryRecord,
  GenerationTask,
  Harness,
  hook,
  type SessionEnd,
  type SettledSubmissionRecord,
  type Storage,
  type Submission,
  type SubmissionId,
  type SubmissionRecord,
  section,
  type UserInput,
  watchEvents,
} from "@earendil-works/pi-durable";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import dotenv from "dotenv";
import { logVerbose } from "../globals.js";
import {
  formatGlobalMemoryBlock,
  formatUserMemoryBlock,
  loadGlobalMemory,
  loadUserMemory,
} from "./memory-store.js";
import { loadScratchpad, SLACK_BASE } from "./pi-agent-scratchpad.js";

const ctx = BACKGROUND_CONTEXT;

export const DB_FILE = "durable.sqlite";
export const SESSIONS_FILE = "durable-sessions.json";
export const STREAMED_FILE = "durable-streamed.json";
export const DELIVERED_KIND = "relay.delivered";
export const PLACEHOLDER_KIND = "relay.placeholder";
export const MAX_RESUMES = 3;
const EVENT_LAG_MS = 3000;
const TICK_MS = 5000;
const FALLBACK_FOLDERS = new Set(["@unknown", "@user"]);

const REPLAY_SAFE = new Set([
  "read_file",
  "list_directory",
  "search",
  "web_search",
  "web_fetch",
  "get_current_time",
  "canvas_sections_lookup",
  "agent_status",
  "memory_query",
  "do_list_apps",
  "do_app_logs",
  "do_app_spec",
  "do_list_deployments",
  "do_list_alerts",
]);

export function replayPolicy(toolName: string): "safe" | "unsafe" {
  return REPLAY_SAFE.has(toolName.toLowerCase()) ? "safe" : "unsafe";
}

export function defaultStateDir(): string {
  return (
    process.env.RELAY01_STATE_DIR || path.join(os.homedir(), "relay01", "state")
  );
}

export interface SlackTarget {
  channel: string;
  user?: string;
  isDm: boolean;
  folder: string;
}

export interface SessionEntry {
  conversationId: ConversationId;
  folder: string;
  userId?: string;
  isDm: boolean;
}

export class RefusedSession extends Error {}

export function sessionKey(
  target: Pick<SlackTarget, "channel" | "user" | "isDm">,
): string {
  if (!target.isDm) return target.channel;
  if (!target.user)
    throw new RefusedSession(`DM ${target.channel} has no user id`);
  return `${target.channel}:${target.user}`;
}

export function isFallbackFolder(folder: string, user?: string): boolean {
  return (
    FALLBACK_FOLDERS.has(folder) ||
    (user !== undefined && folder === `@${user}`)
  );
}

function writeAtomic(file: string, text: string) {
  const temp = `${file}.${process.pid}.tmp`;
  writeFileSync(temp, text, { mode: 0o600 });
  renameSync(temp, file);
}

export class SessionMap {
  private entries: Record<string, SessionEntry>;

  constructor(readonly file: string | null) {
    this.entries =
      file && existsSync(file) ? JSON.parse(readFileSync(file, "utf8")) : {};
  }

  get(key: string): SessionEntry | undefined {
    return this.entries[key];
  }

  keys(): string[] {
    return Object.keys(this.entries);
  }

  keyOf(conversationId: ConversationId): string | undefined {
    return this.keys().find(
      (key) => this.entries[key].conversationId === conversationId,
    );
  }

  set(key: string, entry: SessionEntry) {
    this.entries = { ...this.entries, [key]: entry };
    if (this.file)
      writeAtomic(this.file, JSON.stringify(this.entries, null, 2));
  }
}

export class StreamedReplies {
  private ids: string[];

  constructor(private file: string | null) {
    this.ids =
      file && existsSync(file) ? JSON.parse(readFileSync(file, "utf8")) : [];
  }

  has(id: string) {
    return this.ids.includes(id);
  }

  add(id: string) {
    if (this.has(id)) return;
    this.ids = [...this.ids, id].slice(-50);
    this.save();
  }

  delete(id: string) {
    if (!this.has(id)) return;
    this.ids = this.ids.filter((known) => known !== id);
    this.save();
  }

  private save() {
    if (this.file) writeAtomic(this.file, JSON.stringify(this.ids));
  }
}

export function readDurableFlags(slackBase: string = SLACK_BASE): Set<string> {
  const flagged = new Set<string>();
  let folders: string[];
  try {
    folders = readdirSync(slackBase, { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => d.name);
  } catch {
    return flagged;
  }
  for (const folder of folders) {
    const file = path.join(slackBase, folder, ".env");
    if (!existsSync(file)) continue;
    try {
      if (dotenv.parse(readFileSync(file)).USE_DURABLE === "true")
        flagged.add(folder);
    } catch (err) {
      console.warn(`[durable] Could not read ${file}: ${err}`);
    }
  }
  return flagged;
}

export class DurableRouting {
  constructor(
    readonly flagged: ReadonlySet<string>,
    private sessions: SessionMap,
  ) {}

  route(target: SlackTarget): "durable" | "legacy" | "refused" {
    let key: string;
    try {
      key = sessionKey(target);
    } catch {
      return this.flagged.has(target.folder) ? "refused" : "legacy";
    }
    if (this.sessions.get(key)) return "durable";
    if (!this.flagged.has(target.folder)) return "legacy";
    return isFallbackFolder(target.folder, target.user) ? "refused" : "durable";
  }
}

function isAlive(pid: number) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
}

function claimStorage(lockFile: string) {
  const holder = existsSync(lockFile)
    ? Number(readFileSync(lockFile, "utf8"))
    : 0;
  if (holder && holder !== process.pid && isAlive(holder))
    throw new Error(`${lockFile}: storage is open in process ${holder}`);
  writeFileSync(lockFile, String(process.pid), { mode: 0o600 });
}

function releaseStorage(lockFile: string) {
  if (
    existsSync(lockFile) &&
    Number(readFileSync(lockFile, "utf8")) === process.pid
  )
    rmSync(lockFile, { force: true });
}

export async function openStateStorage(stateDir: string): Promise<Storage> {
  mkdirSync(stateDir, { recursive: true, mode: 0o700 });
  const db = path.join(stateDir, DB_FILE);
  claimStorage(`${db}.pid`);
  closeSync(openSync(db, "a", 0o600));
  chmodSync(db, 0o600);
  const storage = await openNodeSqliteStorage(db);
  for (const file of [db, `${db}-wal`, `${db}-shm`])
    if (existsSync(file)) chmodSync(file, 0o600);
  return storage;
}

export function latestAssistantText(messages: readonly AgentMessage[]): string {
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
}

function adaptTool(tool: AgentTool<any>) {
  return defineTool({
    name: tool.name,
    description: tool.description,
    parameters: tool.parameters as never,
    replay: replayPolicy(tool.name),
    execute: async (args, api, context) => {
      const result = await tool.execute(api.callId, args, context.abortSignal);
      let details: unknown;
      try {
        details =
          result.details === undefined
            ? undefined
            : JSON.parse(JSON.stringify(result.details));
      } catch {}
      return {
        output: result.content,
        isError: (result as { isError?: boolean }).isError,
        details: details as never,
      };
    },
  });
}

function bridgeProvider(
  id: string,
  models: Model<Api>[],
  getApiKey: (provider: string) => Promise<string | undefined>,
) {
  const withSession = <
    O extends { sessionId?: string; headers?: ProviderHeaders },
  >(
    options: O | undefined,
  ): O | undefined =>
    id.startsWith("opencode") && options?.sessionId
      ? {
          ...options,
          headers: {
            ...options.headers,
            "x-opencode-session": options.sessionId,
          },
        }
      : options;
  return createProvider({
    id,
    auth: {
      apiKey: {
        name: `${id} (relay01)`,
        resolve: async () => {
          const apiKey = await getApiKey(id);
          return apiKey ? { auth: { apiKey }, source: "relay01" } : undefined;
        },
      },
    },
    models,
    api: {
      stream: (model, context, options) =>
        stream(model, context as never, withSession(options) as never),
      streamSimple: (model, context, options) =>
        streamSimple(model, context as never, withSession(options)),
    },
  });
}

export function injectMemory(
  messages: readonly Message[],
  block: string,
): Message[] {
  const [first, ...rest] = messages;
  if (first?.role === "system") {
    const content =
      typeof first.content === "string"
        ? `${block}\n${first.content}`
        : [{ type: "text" as const, text: `${block}\n` }, ...first.content];
    return [{ ...first, content }, ...rest];
  }
  return [
    { role: "system", content: block, timestamp: Date.now() },
    ...messages,
  ];
}

export async function memoryBlock(
  entry: SessionEntry,
  requestUser: string | undefined,
): Promise<string> {
  const parts: string[] = [];
  const global = await loadGlobalMemory();
  if (global) parts.push(formatGlobalMemoryBlock(global));
  if (entry.isDm && entry.userId && requestUser === entry.userId) {
    const user = await loadUserMemory(entry.userId);
    if (user) parts.push(formatUserMemoryBlock(entry.folder.slice(1), user));
  }
  const critical = (await loadScratchpad(entry.folder))?.critical ?? [];
  if (critical.length)
    parts.push(
      `Memory from previous sessions:\n${critical.map((c) => `- ${c}`).join("\n")}\n`,
    );
  return parts.join("\n");
}

export interface DurableSetup {
  model: Model<Api>;
  thinkingLevel?: string;
  systemPrompt: string;
  tools: AgentTool<any>[];
}

export interface SlackEntryData {
  channel: string;
  threadTs?: string;
  user?: string;
  source: "dm" | "channel";
}

export interface ToolActivity {
  phase: "start" | "end";
  toolName: string;
  toolCallId: string;
  isError?: boolean;
}

export interface SubmitInput {
  text: string;
  images?: ImageContent[];
  entry:
    | { kind: "slack.message"; data: SlackEntryData }
    | { kind: string; data?: Record<string, string | undefined> };
  requestId?: string;
}

export interface RunGuard {
  timeoutMs: number;
  isPaused?(): boolean;
}

export interface WaitInput extends RunGuard {
  onStart?(): void;
  onText?(text: string): void;
  onToolActivity?(activity: ToolActivity): void;
}

export type AskInput = SubmitInput & WaitInput;

export interface AskResult {
  text: string;
  messages: AgentMessage[];
  duplicate?: boolean;
  unanswered?: { reason: string; detail?: unknown };
}

export class AskTimeout extends Error {
  constructor(readonly messages: AgentMessage[]) {
    super("Agent timeout");
  }
}

type Caller = Pick<WaitInput, "onStart" | "onText" | "onToolActivity">;

interface RunRecord {
  inputs: readonly SubmissionId[];
  caller?: Caller;
  messages: AgentMessage[];
  ended: boolean;
  done: Promise<void>;
  end(): void;
  disarm?(): void;
}

function answered(run: RunRecord) {
  for (let i = run.messages.length - 1; i >= 0; i--) {
    const message = run.messages[i];
    if (!("role" in message) || message.role === "system") continue;
    return (
      message.role === "assistant" &&
      !message.content.some((b) => b.type === "toolCall")
    );
  }
  return false;
}

function contextSize(messages: readonly Message[]) {
  return `${messages.length} messages, ${JSON.stringify(messages).length} chars`;
}

export type OrphanSettled = (
  record: SettledSubmissionRecord,
  text: string,
) => void;

export class ChatRuntime {
  private callers = new Map<SubmissionId, Caller>();
  private runs = new Map<SubmissionId, RunRecord>();
  private current: RunRecord | undefined;
  private next: AgentMessage[] = [];
  private queued = 0;
  private settled = new Set<SubmissionId>();
  private events: AgentEventStream | undefined;
  private blocks: Array<{ type: string; text?: string }> = [];
  private shown = "";
  private compactionStart: Promise<string> | undefined;

  constructor(
    readonly key: string,
    readonly host: DurableHost,
    readonly conversation: Conversation,
    private orphans: Set<SubmissionId>,
    private onOrphanSettled: OrphanSettled,
    private guard?: RunGuard,
  ) {}

  async start() {
    this.events = await watchEvents(
      this.host.harness,
      this.conversation.id,
      ctx,
    );
    const running = this.events.snapshot.run;
    if (running) this.current = this.newRun(running.inputs);
    this.queued = this.events.snapshot.inbox.length;
    this.events.start(async (batch) => {
      for (const event of batch) this.handle(event);
    });
  }

  async close() {
    await this.events?.stop();
  }

  get busy() {
    return (
      this.current !== undefined || this.queued > 0 || this.callers.size > 0
    );
  }

  status() {
    return {
      hasActiveRun: this.current !== undefined,
      queueLength: this.queued,
    };
  }

  currentInputs(): readonly SubmissionId[] {
    return this.current?.inputs ?? [];
  }

  stopCurrentRun(): Promise<boolean> {
    return this.host.abortRun(this.conversation.id);
  }

  submit(input: SubmitInput): Promise<Submission> {
    const content: UserInput = input.images?.length
      ? [{ type: "text", text: input.text }, ...input.images]
      : input.text;
    return this.conversation.submit(
      {
        type: "input",
        content,
        entry: { kind: input.entry.kind, data: input.entry.data as never },
        ...(input.requestId ? { requestId: input.requestId } : {}),
      },
      ctx,
    );
  }

  position(id: SubmissionId): Promise<number> {
    return this.host.position(this.conversation.id, id);
  }

  async record(kind: string, data: Record<string, string>): Promise<void> {
    await this.conversation.submit(
      { type: "write", entry: { kind, data } },
      ctx,
    );
  }

  async ask(input: AskInput): Promise<AskResult> {
    const submission = await this.submit(input);
    if (input.requestId) {
      const status = (await submission.status(ctx)).status;
      if (status === "done" || status === "unanswered") {
        logVerbose(
          `[durable ${this.key}] ${input.requestId} was already answered; not running it again`,
        );
        return { text: "", messages: [], duplicate: true };
      }
    }
    return this.wait(submission, input);
  }

  async wait(submission: Submission, input: WaitInput): Promise<AskResult> {
    const caller: Caller = {
      onStart: input.onStart,
      onText: input.onText,
      onToolActivity: input.onToolActivity,
    };
    this.callers.set(submission.id, caller);
    const started = this.runs.get(submission.id);
    if (started && !started.caller) {
      started.caller = caller;
      started.disarm?.();
      if (!started.ended) caller.onStart?.();
    }
    try {
      const settled = await this.settle(submission, input);
      const record = await this.runOf(submission.id);
      const messages = record?.messages ?? [];
      if (settled.status === "unanswered")
        return {
          text: "",
          messages,
          unanswered: { reason: settled.reason, detail: settled.detail },
        };
      return { text: latestAssistantText(messages), messages };
    } finally {
      this.callers.delete(submission.id);
    }
  }

  private async settle(
    submission: Submission,
    guard: RunGuard,
  ): Promise<SettledSubmissionRecord> {
    const { context, cancel } = withCancel(ctx);
    let timedOut = false;
    const disarm = this.countdown(submission.id, guard, () => {
      timedOut = true;
      cancel();
    });
    try {
      return await submission.wait(context);
    } catch (err) {
      if (!timedOut) throw err;
      await this.stopCurrentRun();
      throw new AskTimeout((await this.runOf(submission.id))?.messages ?? []);
    } finally {
      disarm();
    }
  }

  private countdown(
    id: SubmissionId,
    guard: RunGuard,
    expire: () => void,
  ): () => void {
    const tickMs = Math.min(
      TICK_MS,
      Math.max(10, Math.floor(guard.timeoutMs / 10)),
    );
    let remaining = guard.timeoutMs;
    const timer = setInterval(() => {
      if (!this.current?.inputs.includes(id) || guard.isPaused?.()) return;
      remaining -= tickMs;
      if (remaining > 0) return;
      clearInterval(timer);
      expire();
    }, tickMs);
    return () => clearInterval(timer);
  }

  private guardOrphan(record: RunRecord) {
    const id = record.inputs[0];
    if (!this.guard || record.caller || !this.orphans.has(id)) return;
    record.disarm = this.countdown(id, this.guard, () => {
      console.error(
        `[durable ${this.key}] Resumed run ${id} ran past ${this.guard?.timeoutMs}ms; stopping it`,
      );
      void this.stopCurrentRun().catch((err) =>
        console.error(`[durable ${this.key}] Could not stop run ${id}: ${err}`),
      );
    });
  }

  private async runOf(id: SubmissionId): Promise<RunRecord | undefined> {
    const deadline = Date.now() + EVENT_LAG_MS;
    while (Date.now() < deadline) {
      const record = this.runs.get(id);
      if (record?.ended) return record;
      if (!record && this.settled.has(id)) return undefined;
      if (record)
        await Promise.race([
          record.done,
          new Promise((r) => setTimeout(r, deadline - Date.now())),
        ]);
      else await new Promise((r) => setTimeout(r, 50));
    }
    return this.runs.get(id);
  }

  private newRun(inputs: readonly SubmissionId[]): RunRecord {
    let end: () => void = () => {};
    const done = new Promise<void>((resolve) => {
      end = resolve;
    });
    const record: RunRecord = {
      inputs,
      caller: this.callers.get(inputs[0]),
      messages: this.next.splice(0),
      ended: false,
      done,
      end,
    };
    this.runs.set(inputs[0], record);
    for (const id of [...this.runs.keys()].slice(0, -20)) this.runs.delete(id);
    if (record.caller) record.caller.onStart?.();
    else this.guardOrphan(record);
    return record;
  }

  private showReply() {
    const text = this.blocks
      .filter((b) => b.type === "text")
      .map((b) => b.text ?? "")
      .join("");
    if (text !== this.shown) {
      this.shown = text;
      this.current?.caller?.onText?.(text);
    }
  }

  private noteCompaction(kind: string) {
    if (kind !== "pi.compaction") return;
    const before = this.compactionStart;
    this.compactionStart = undefined;
    void (async () => {
      const after = contextSize(
        (await this.conversation.context(ctx)).messages,
      );
      console.log(
        `[durable ${this.key}] Compacted: ${before ? await before : "unknown"} -> ${after}`,
      );
    })().catch((err) =>
      console.error(
        `[durable ${this.key}] Could not measure compaction: ${err}`,
      ),
    );
  }

  private handle(event: AgentEvent) {
    switch (event.type) {
      case "run_start":
        this.current = this.newRun(event.inputs);
        break;
      case "message_start":
        if (event.message.role === "assistant") {
          this.blocks = [];
          this.shown = "";
        }
        break;
      case "message_update":
        for (const change of event.changes) {
          if (change.type === "message")
            this.blocks = change.message.content.map((b) => ({ ...b }));
          else if (change.type === "text_delta") {
            const block = this.blocks[change.contentIndex];
            if (block) block.text = (block.text ?? "") + change.delta;
          } else if ("block" in change)
            this.blocks[change.contentIndex] = { ...change.block };
        }
        this.showReply();
        break;
      case "message_end":
        this.noteCompaction(event.entry.kind);
        for (const message of event.entry.model ?? []) {
          if (message.role === "assistant") {
            this.blocks = message.content.map((b) => ({ ...b }));
            this.showReply();
          }
          if (message.role === "user" && this.current && answered(this.current))
            this.next.push(message as AgentMessage);
          else this.current?.messages.push(message as AgentMessage);
        }
        break;
      case "entry_appended":
        this.noteCompaction(event.entry.kind);
        break;
      case "tool_execution_start":
        this.current?.caller?.onToolActivity?.({
          phase: "start",
          toolName: event.toolName,
          toolCallId: event.toolCallId,
        });
        break;
      case "tool_execution_end": {
        const result = event.entry?.model?.[0] as
          | { isError?: boolean }
          | undefined;
        this.current?.caller?.onToolActivity?.({
          phase: "end",
          toolName: event.toolName,
          toolCallId: event.toolCallId,
          isError: result?.isError === true,
        });
        break;
      }
      case "run_end": {
        const record = this.current ?? this.runs.get(event.inputs[0]);
        this.current = undefined;
        if (!record) break;
        record.disarm?.();
        record.ended = true;
        record.end();
        break;
      }
      case "inbox_update":
        this.queued = event.items.length;
        break;
      case "compaction_start":
        this.compactionStart = this.conversation
          .context(ctx)
          .then((view) => contextSize(view.messages))
          .catch(() => "unknown");
        console.log(
          `[durable ${this.key}] Compaction started (${event.reason}${event.blocking ? ", blocking" : ""})`,
        );
        break;
      case "compaction_end":
        if (event.error)
          console.error(
            `[durable ${this.key}] Compaction failed (${event.reason}): ${event.error}`,
          );
        break;
      case "submission":
        this.onSubmission(event.record);
        break;
    }
  }

  private onSubmission(record: SubmissionRecord) {
    if (record.status !== "done" && record.status !== "unanswered") return;
    this.settled.add(record.id);
    for (const id of [...this.settled].slice(0, -50)) this.settled.delete(id);
    if (record.status === "unanswered" && record.type === "input")
      console.error(
        `[durable ${this.key}] Input ${record.requestId ?? record.id} unanswered: ${record.reason}${record.detail === undefined ? "" : ` (${JSON.stringify(record.detail)})`}`,
      );
    if (!this.orphans.delete(record.id) || this.callers.has(record.id)) return;
    const settled = record as SettledSubmissionRecord;
    void this.runOf(record.id).then((run) => {
      const text =
        record.status === "done" && run
          ? latestAssistantText(run.messages)
          : "";
      this.onOrphanSettled(settled, text);
    });
  }
}

const ResumeAttempts = defineDoc<{ attempts: Record<string, number> }>({
  kind: "relay01.resume-attempts",
  version: 1,
  scope: "session",
  initial: () => ({ attempts: {} }),
});

export interface DurableHostOptions {
  getApiKey: (provider: string) => Promise<string | undefined>;
  stateDir?: string;
  storage?: Storage;
  onUnexpectedClose?: (end: SessionEnd) => void;
  onResumeLimit?: (key: string | undefined, record: SubmissionRecord) => void;
}

export class DurableHost {
  readonly runtimes = new Map<string, ChatRuntime>();
  private known = new Map<string, Map<string, Model<Api>>>();
  private closing = false;

  private constructor(
    readonly harness: Harness,
    readonly sessions: SessionMap,
    private models: MutableModels,
    private registry: ReturnType<typeof createRegistry>,
    private options: DurableHostOptions,
    private lockFile: string | undefined,
    private storage: Storage,
  ) {
    harness.closed.then((end) => {
      if (this.closing) return;
      console.error(
        `[durable] Harness closed unexpectedly: ${end.reason === "failed" ? end.error : end.reason}`,
      );
      (options.onUnexpectedClose ?? (() => process.exit(1)))(end);
    });
  }

  static async open(options: DurableHostOptions): Promise<DurableHost> {
    const stateDir = options.stateDir ?? defaultStateDir();
    mkdirSync(stateDir, { recursive: true, mode: 0o700 });
    const storage = options.storage ?? (await openStateStorage(stateDir));
    const models = createModels();
    const registry = createRegistry();
    const harness = await Harness.open(
      storage,
      {
        models,
        registry,
        settings: { compaction: { enabled: true }, extensions: [] },
        onReport: (err) => console.error(`[durable] ${err}`),
      },
      ctx,
    );
    logVerbose(
      `[durable] Opened ${options.storage ? "storage" : path.join(stateDir, DB_FILE)}`,
    );
    return new DurableHost(
      harness,
      new SessionMap(path.join(stateDir, SESSIONS_FILE)),
      models,
      registry,
      options,
      options.storage ? undefined : path.join(stateDir, `${DB_FILE}.pid`),
      storage,
    );
  }

  keyOfFolder(folder: string): string | undefined {
    return this.sessions
      .keys()
      .find((key) => this.sessions.get(key)?.folder === folder);
  }

  existing(
    conversationId: ConversationId,
    requestId: string,
  ): Promise<SubmissionRecord | undefined> {
    return this.storage.submissionByRequest(conversationId, requestId, ctx);
  }

  async position(
    conversationId: ConversationId,
    id: SubmissionId,
  ): Promise<number> {
    const inspection = await this.harness.inspect(ctx);
    const index = inspection.submissions
      .filter((s) => s.conversationId === conversationId && s.type === "input")
      .findIndex((s) => s.id === id);
    return Math.max(index, 0);
  }

  async settledInputs(
    conversationId: ConversationId,
    limit = 50,
  ): Promise<SettledSubmissionRecord[]> {
    const page = await this.storage.scanSubmissions(
      { conversationId, order: "descending" },
      limit,
      undefined,
      ctx,
    );
    return page.items.filter(
      (s): s is SettledSubmissionRecord =>
        s.type === "input" &&
        (s.status === "done" || s.status === "unanswered"),
    );
  }

  async entry(id: EntryId): Promise<EntryRecord | undefined> {
    return (await this.storage.entry(id, ctx))?.entry;
  }

  async deliveries(
    conversationId: ConversationId,
    from: EntryId,
  ): Promise<{ delivered: Set<string>; placeholders: Map<string, string> }> {
    const delivered = new Set<string>();
    const placeholders = new Map<string, string>();
    const conversation = await this.harness.conversation(conversationId, ctx);
    if (!conversation) return { delivered, placeholders };
    let cursor: Cursor | undefined;
    do {
      const page = await conversation.entries(
        { minEntryId: from },
        200,
        cursor,
        ctx,
      );
      for (const entry of page.items) {
        const data = entry.data as { requestId?: unknown; ts?: unknown };
        if (typeof data?.requestId !== "string") continue;
        if (entry.kind === DELIVERED_KIND) delivered.add(data.requestId);
        else if (
          entry.kind === PLACEHOLDER_KIND &&
          typeof data.ts === "string" &&
          !placeholders.has(data.requestId)
        )
          placeholders.set(data.requestId, data.ts);
      }
      cursor = page.next;
    } while (cursor);
    return { delivered, placeholders };
  }

  async ensureSession(
    target: SlackTarget,
  ): Promise<{ key: string; entry: SessionEntry }> {
    const key = sessionKey(target);
    const existing = this.sessions.get(key);
    if (existing) return { key, entry: existing };
    if (isFallbackFolder(target.folder, target.user))
      throw new RefusedSession(
        `Refusing to create a durable conversation for fallback session ${target.folder}`,
      );
    const created = await this.harness.createConversation(
      { ownership: { kind: "ownerless" } },
      ctx,
    );
    const entry: SessionEntry = {
      conversationId: created.id,
      folder: target.folder,
      isDm: target.isDm,
      ...(target.isDm && target.user ? { userId: target.user } : {}),
    };
    this.sessions.set(key, entry);
    return { key, entry };
  }

  async pending(): Promise<Map<string, Set<SubmissionId>>> {
    const inspection = await this.harness.inspect(ctx);
    const byKey = new Map<string, Set<SubmissionId>>();
    for (const record of inspection.submissions) {
      const key = this.sessions.keyOf(record.conversationId);
      if (key) byKey.set(key, (byKey.get(key) ?? new Set()).add(record.id));
    }
    return byKey;
  }

  async attach(
    key: string,
    setup: DurableSetup,
    orphans = new Set<SubmissionId>(),
    onOrphanSettled: OrphanSettled = () => {},
    guard?: RunGuard,
  ): Promise<ChatRuntime> {
    const entry = this.sessions.get(key);
    if (!entry) throw new Error(`No durable session for ${key}`);
    this.addModel(setup.model);
    const extension = defineExtension({
      name: `relay01:${key}`,
      tools: setup.tools.map(adaptTool),
      sections: [section("relay01", () => setup.systemPrompt, { tag: false })],
      hooks: [
        hook(GenerationTask, {
          beforeRequest: async ({ messages }, api) => {
            try {
              const block = await memoryBlock(
                entry,
                await this.requestUser(api.conversationId),
              );
              return block
                ? { messages: injectMemory(messages, block) }
                : undefined;
            } catch (err) {
              console.error(
                `[durable ${key}] Memory injection failed; sending without it: ${err}`,
              );
              return undefined;
            }
          },
        }),
      ],
    });
    this.registry.install(extension);
    const conversation = await this.harness.conversation(
      entry.conversationId,
      ctx,
    );
    if (!conversation)
      throw new Error(
        `Durable conversation ${entry.conversationId} for ${key} is missing`,
      );
    await conversation.configure(
      {
        model: { provider: setup.model.provider, modelId: setup.model.id },
        thinkingLevel: (setup.thinkingLevel ?? null) as never,
        extensions: [extension],
      },
      ctx,
    );
    await this.runtimes.get(key)?.close();
    const runtime = new ChatRuntime(
      key,
      this,
      conversation,
      orphans,
      onOrphanSettled,
      guard,
    );
    await runtime.start();
    this.runtimes.set(key, runtime);
    return runtime;
  }

  async resume() {
    for (const record of await this.countResumes()) {
      const key = this.sessions.keyOf(record.conversationId);
      console.error(
        `[durable ${key ?? record.conversationId}] ${record.requestId ?? record.id} resumed ${MAX_RESUMES} times; aborting it`,
      );
      await this.markAbort(record.conversationId);
      this.options.onResumeLimit?.(key, record);
    }
    this.harness.resume();
  }

  async abortRun(conversationId: ConversationId): Promise<boolean> {
    const aborted = await this.markAbort(conversationId);
    for (
      let i = 0;
      i < 200 && (await this.liveGenerations(conversationId)).length > 0;
      i++
    )
      await new Promise((r) => setTimeout(r, 50));
    const inspection = await this.harness.inspect(ctx);
    const waiting = inspection.submissions.some(
      (s) =>
        s.conversationId === conversationId &&
        s.type === "input" &&
        s.status === "queued",
    );
    const conversation = await this.harness.conversation(conversationId, ctx);
    if (waiting && conversation)
      await conversation.submit(
        {
          type: "write",
          entry: {
            kind: "relay.run-stopped",
            data: { at: Date.now() },
            model: [],
          },
        },
        ctx,
      );
    return aborted;
  }

  async close() {
    this.closing = true;
    for (const runtime of this.runtimes.values()) await runtime.close();
    this.runtimes.clear();
    await this.harness.close(ctx);
    if (this.lockFile) releaseStorage(this.lockFile);
  }

  private async liveGenerations(conversationId: ConversationId) {
    const inspection = await this.harness.inspect(ctx);
    return inspection.tasks.filter(
      (t) =>
        t.record.conversationId === conversationId &&
        t.record.kind === GenerationTask.definition.name &&
        t.record.owner === undefined &&
        !t.record.background,
    );
  }

  private async markAbort(conversationId: ConversationId): Promise<boolean> {
    let aborted = false;
    for (let i = 0; i < 5; i++) {
      const live = (await this.liveGenerations(conversationId)).filter(
        (t) => !t.record.abortRequested,
      );
      if (live.length === 0) break;
      for (const task of live)
        await this.harness.abortTask(task.record.id, ctx);
      aborted = true;
    }
    return aborted;
  }

  private async countResumes(): Promise<SubmissionRecord[]> {
    const inspection = await this.harness.inspect(ctx);
    const placed = inspection.submissions.filter(
      (s) => s.type === "input" && s.status === "placed",
    );
    const over: SubmissionRecord[] = [];
    await this.harness.commit(async (tx) => {
      const doc = await tx.doc(ResumeAttempts);
      const attempts: Record<string, number> = {};
      for (const record of placed) {
        const n = (doc.attempts[String(record.id)] ?? 0) + 1;
        attempts[String(record.id)] = n;
        if (n > MAX_RESUMES) over.push(record);
      }
      doc.attempts = attempts;
    }, ctx);
    return over;
  }

  private async requestUser(
    conversationId: ConversationId,
  ): Promise<string | undefined> {
    const conversation = await this.harness.conversation(conversationId, ctx);
    if (!conversation) return undefined;
    const page = await conversation.entries({}, 50, undefined, ctx);
    for (const entry of page.items) {
      if (entry.kind !== "slack.message") continue;
      const user = (entry.data as { user?: unknown } | undefined)?.user;
      return typeof user === "string" ? user : undefined;
    }
    return undefined;
  }

  private addModel(model: Model<Api>) {
    const list =
      this.known.get(model.provider) ?? new Map<string, Model<Api>>();
    list.set(model.id, model);
    this.known.set(model.provider, list);
    this.models.setProvider(
      bridgeProvider(
        model.provider,
        [...list.values()],
        this.options.getApiKey,
      ),
    );
  }
}
