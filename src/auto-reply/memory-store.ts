// Host-side shared memory store (global scope + user scope)
//
// Lives at ~/relay01/memory/ — deliberately OUTSIDE ~/relay01/slack/ so no
// session sandbox can bind or path-traverse into it. Sessions only ever
// see memory the host injects into their system prompt.
//
// Scopes:
//   global/            facts injected into EVERY session
//   users/{userId}/    facts about one person, keyed by Slack user ID
//                      (stable across username changes). Privacy rule:
//                      user memory is only injected into that user's DM.
//
// Each scope has the same layout: MEMORY.md (consolidated, injected),
// pending.jsonl (proposal inbox), pending.archive.jsonl (audit trail).
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { logVerbose } from "../globals.js";

export const MEMORY_BASE = path.join(os.homedir(), "relay01", "memory");

export type MemoryScope = { kind: "global" } | { kind: "user"; userId: string };

// Consolidate once this many facts are waiting in a scope's inbox
const CONSOLIDATE_THRESHOLD: Record<MemoryScope["kind"], number> = {
  global: 10,
  user: 5,
};

// Cap the injected block so a runaway file can't blow up every prompt.
// ~6000 chars ≈ 1500 tokens.
const MAX_INJECTED_CHARS = 6000;

const SEED_TEMPLATE = `# Global memory

Facts listed here are injected into every relay01 session's system prompt.
Edit by hand. One fact per bullet. Keep it short — this costs tokens on
every conversation.

- (example) Team demo day is Fridays.
`;

function scopeDir(scope: MemoryScope): string {
  if (scope.kind === "global") return path.join(MEMORY_BASE, "global");
  // Slack user IDs are alphanumeric (e.g. U0123ABCD); reject anything that
  // could traverse out of the users directory.
  if (!/^[A-Za-z0-9_-]+$/.test(scope.userId)) {
    throw new Error(`Invalid user ID for memory scope: ${scope.userId}`);
  }
  return path.join(MEMORY_BASE, "users", scope.userId);
}

function scopeKey(scope: MemoryScope): string {
  return scope.kind === "global" ? "global" : `user:${scope.userId}`;
}

function memoryPath(scope: MemoryScope): string {
  return path.join(scopeDir(scope), "MEMORY.md");
}

function pendingPath(scope: MemoryScope): string {
  return path.join(scopeDir(scope), "pending.jsonl");
}

function archivePath(scope: MemoryScope): string {
  return path.join(scopeDir(scope), "pending.archive.jsonl");
}

/**
 * Ensure ~/relay01/memory/global/MEMORY.md exists, seeding a template on
 * first run so admins can discover and hand-edit it.
 */
export async function ensureGlobalMemoryFile(): Promise<void> {
  const target = memoryPath({ kind: "global" });
  await fs.mkdir(path.dirname(target), { recursive: true });
  try {
    await fs.writeFile(target, SEED_TEMPLATE, { flag: "wx" });
    logVerbose(`[memory-store] Seeded global memory template at ${target}`);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
  }
}

/**
 * Load a scope's memory content, or null if the file is missing, empty,
 * or (global only) still the untouched seed template.
 */
async function loadMemory(scope: MemoryScope): Promise<string | null> {
  let content: string;
  try {
    content = await fs.readFile(memoryPath(scope), "utf-8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      logVerbose(`[memory-store] No memory file for ${scopeKey(scope)}`);
      return null;
    }
    console.warn(`[memory-store] WARNING: Failed to load ${scopeKey(scope)} memory: ${err}`);
    return null;
  }

  const trimmed = content.trim();
  if (!trimmed) return null;
  if (scope.kind === "global" && trimmed === SEED_TEMPLATE.trim()) return null;

  if (trimmed.length > MAX_INJECTED_CHARS) {
    console.warn(
      `[memory-store] WARNING: ${scopeKey(scope)} memory is ${trimmed.length} chars, truncating to ${MAX_INJECTED_CHARS}`,
    );
    return `${trimmed.slice(0, MAX_INJECTED_CHARS)}\n\n[memory truncated — trim ${memoryPath(scope)}]`;
  }

  return trimmed;
}

export async function loadGlobalMemory(): Promise<string | null> {
  return loadMemory({ kind: "global" });
}

export async function loadUserMemory(userId: string): Promise<string | null> {
  return loadMemory({ kind: "user", userId });
}

/**
 * Format global memory as a labeled system prompt block.
 */
export function formatGlobalMemoryBlock(content: string): string {
  return `## Shared memory (global — applies across all sessions)\n${content}\n`;
}

/**
 * Format user memory as a labeled system prompt block (DM injection only).
 */
export function formatUserMemoryBlock(userName: string, content: string): string {
  return `## About @${userName} (remembered across sessions)\n${content}\n`;
}

/**
 * Record the user ID ↔ username mapping. Usernames change; the user ID is
 * the stable key. Kept as a small JSON file per user for later lookups.
 */
export async function recordUserIdentity(userId: string, userName: string): Promise<void> {
  const scope: MemoryScope = { kind: "user", userId };
  const identityFile = path.join(scopeDir(scope), "identity.json");

  await withScopeLock(scope, async () => {
    let known: { userId: string; userNames: string[] } = { userId, userNames: [] };
    try {
      known = JSON.parse(await fs.readFile(identityFile, "utf-8"));
    } catch {
      // first sighting
    }
    if (known.userNames.includes(userName)) return;
    known.userNames.push(userName);
    await fs.mkdir(scopeDir(scope), { recursive: true });
    await fs.writeFile(identityFile, JSON.stringify(known, null, 2), "utf-8");
    logVerbose(`[memory-store] Recorded identity ${userId} ↔ @${userName}`);
  });
}

// ============================================================================
// Harvest path: pending inbox + consolidation
// ============================================================================

export interface ProposedFact {
  text: string;
  sourceSession: string; // "@username" or "#channelname"
  timestamp: string; // ISO 8601
}

// Serialize writes per scope. Sessions can end concurrently, and
// consolidation must not race with new proposals.
const scopeLocks = new Map<string, Promise<unknown>>();

function withScopeLock<T>(scope: MemoryScope, fn: () => Promise<T>): Promise<T> {
  const key = scopeKey(scope);
  const prev = scopeLocks.get(key) ?? Promise.resolve();
  const run = prev.then(fn, fn);
  scopeLocks.set(
    key,
    run.catch(() => {}),
  );
  return run;
}

/**
 * Append proposed facts to a scope's pending inbox. Facts do NOT go
 * straight into MEMORY.md — the consolidation pass merges them.
 */
async function proposeFacts(scope: MemoryScope, facts: ProposedFact[]): Promise<void> {
  const clean = facts.filter((f) => f.text.trim());
  if (clean.length === 0) return;

  await withScopeLock(scope, async () => {
    await fs.mkdir(scopeDir(scope), { recursive: true });
    const lines = clean.map((f) => JSON.stringify(f)).join("\n") + "\n";
    await fs.appendFile(pendingPath(scope), lines, "utf-8");
  });
  logVerbose(`[memory-store] Proposed ${clean.length} fact(s) to ${scopeKey(scope)} inbox`);
}

export async function proposeGlobalFacts(facts: ProposedFact[]): Promise<void> {
  return proposeFacts({ kind: "global" }, facts);
}

export async function proposeUserFacts(userId: string, facts: ProposedFact[]): Promise<void> {
  return proposeFacts({ kind: "user", userId }, facts);
}

/**
 * Read all pending facts from a scope's inbox. Malformed lines are skipped.
 */
async function readPending(scope: MemoryScope): Promise<ProposedFact[]> {
  let content: string;
  try {
    content = await fs.readFile(pendingPath(scope), "utf-8");
  } catch {
    return [];
  }

  const facts: ProposedFact[] = [];
  for (const line of content.split("\n")) {
    if (!line.trim()) continue;
    try {
      const parsed = JSON.parse(line) as ProposedFact;
      if (typeof parsed.text === "string" && parsed.text.trim()) {
        facts.push(parsed);
      }
    } catch {
      console.warn(`[memory-store] WARNING: Skipping malformed pending line: ${line.slice(0, 80)}`);
    }
  }
  return facts;
}

export async function readPendingFacts(): Promise<ProposedFact[]> {
  return readPending({ kind: "global" });
}

export async function readPendingUserFacts(userId: string): Promise<ProposedFact[]> {
  return readPending({ kind: "user", userId });
}

function buildConsolidationPrompt(
  scope: MemoryScope,
  existing: string | null,
  pending: ProposedFact[],
): string {
  const pendingLines = pending
    .map((f) => `- [${f.sourceSession} @ ${f.timestamp}] ${f.text}`)
    .join("\n");

  const scopeIntro =
    scope.kind === "global"
      ? "You maintain a shared memory file injected into every session of a Slack assistant."
      : "You maintain a memory file about one specific person, injected into that person's DM sessions with a Slack assistant.";

  const scopeRule =
    scope.kind === "global"
      ? '- Drop proposals that are session-specific chatter, one-off tasks, or only about a single user\'s private preferences — keep only facts useful across sessions.'
      : "- Keep durable facts about this person: role, expertise, preferences, ongoing projects, explicit \"remember this\" requests. Drop one-off tasks and session-specific chatter.";

  return `${scopeIntro}

## Current memory:
${existing ?? "(empty)"}

## Newly proposed facts (with source session and time):
${pendingLines}

## Task:
Rewrite the complete memory file, merging the proposed facts into the current memory.

## Rules:
- Deduplicate: merge proposals that restate existing facts.
- Contradictions: newer information wins; drop the outdated fact.
${scopeRule}
- Keep provenance out of the output — plain facts only, one per bullet.
- Keep the file small: max 30 bullets, each one line.
- Output ONLY markdown bullets ("- fact"), no headers, no preamble.`;
}

/**
 * Merge a scope's pending inbox into its MEMORY.md using the provided LLM
 * caller. On success, pending facts move to an archive file (audit trail).
 * On empty/failed LLM output, memory and inbox are left untouched.
 */
async function consolidateMemory(
  scope: MemoryScope,
  llm: (prompt: string) => Promise<string>,
): Promise<void> {
  const pending = await readPending(scope);
  if (pending.length === 0) return;

  const existing = await loadMemory(scope);
  const prompt = buildConsolidationPrompt(scope, existing, pending);
  const response = (await llm(prompt)).trim();

  const bullets = response.split("\n").filter((line) => line.trim().startsWith("- "));
  if (bullets.length === 0) {
    console.warn(
      `[memory-store] WARNING: Consolidation for ${scopeKey(scope)} returned no bullets — keeping existing memory and inbox`,
    );
    return;
  }

  const header = scope.kind === "global" ? "# Global memory" : `# Memory for ${scope.userId}`;

  await withScopeLock(scope, async () => {
    // Write new memory atomically
    const target = memoryPath(scope);
    const tmpPath = `${target}.tmp`;
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.writeFile(tmpPath, `${header}\n\n${bullets.join("\n")}\n`, "utf-8");
    await fs.rename(tmpPath, target);

    // Move consumed facts to the archive. Re-read inside the lock: new
    // proposals may have arrived while the LLM ran; only archive what we
    // actually consolidated.
    const consumed = new Set(pending.map((f) => JSON.stringify(f)));
    let remaining: string[] = [];
    try {
      const current = await fs.readFile(pendingPath(scope), "utf-8");
      remaining = current.split("\n").filter((line) => line.trim() && !consumed.has(line.trim()));
    } catch {
      // inbox vanished — nothing to rewrite
    }
    const archiveLines = pending.map((f) => JSON.stringify(f)).join("\n") + "\n";
    await fs.appendFile(archivePath(scope), archiveLines, "utf-8");
    await fs.writeFile(
      pendingPath(scope),
      remaining.length ? remaining.join("\n") + "\n" : "",
      "utf-8",
    );
  });

  logVerbose(
    `[memory-store] Consolidated ${pending.length} pending fact(s) into ${scopeKey(scope)} memory (${bullets.length} bullets)`,
  );
}

export async function consolidateGlobalMemory(
  llm: (prompt: string) => Promise<string>,
): Promise<void> {
  return consolidateMemory({ kind: "global" }, llm);
}

export async function consolidateUserMemory(
  userId: string,
  llm: (prompt: string) => Promise<string>,
): Promise<void> {
  return consolidateMemory({ kind: "user", userId }, llm);
}

/**
 * Run consolidation only if the scope's inbox has reached its threshold.
 */
async function maybeConsolidate(
  scope: MemoryScope,
  llm: (prompt: string) => Promise<string>,
): Promise<void> {
  const pending = await readPending(scope);
  const threshold = CONSOLIDATE_THRESHOLD[scope.kind];
  if (pending.length < threshold) {
    if (pending.length > 0) {
      logVerbose(
        `[memory-store] ${pending.length}/${threshold} pending facts for ${scopeKey(scope)} — consolidation deferred`,
      );
    }
    return;
  }
  await consolidateMemory(scope, llm);
}

export async function maybeConsolidateGlobalMemory(
  llm: (prompt: string) => Promise<string>,
): Promise<void> {
  return maybeConsolidate({ kind: "global" }, llm);
}

export async function maybeConsolidateUserMemory(
  userId: string,
  llm: (prompt: string) => Promise<string>,
): Promise<void> {
  return maybeConsolidate({ kind: "user", userId }, llm);
}
