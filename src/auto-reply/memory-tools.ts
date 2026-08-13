// Agent-facing tools for the host-side shared memory store.
//
// The store deliberately lives outside every session sandbox (see
// memory-store.ts), so these tools are the ONLY way a session can reach it.
// Two deliberate restrictions follow from that:
//
//   1. Writes never touch MEMORY.md directly. memory_write appends to the
//      scope's pending inbox; the existing consolidation pass merges it.
//      A prompt-injected "remember X" therefore cannot land verbatim in
//      every other session's system prompt.
//   2. User scope is reachable only from that user's DM, matching the
//      injection rule in pi-agent.ts.
//
// Gated behind USE_MEMORY_TOOLS=true. The definitions are always registered
// so tool-name sets stay stable across restarts; only execution is gated.

import type { AgentTool, AgentToolResult } from "@earendil-works/pi-agent-core";
import { Type } from "@sinclair/typebox";

import {
  consolidateThreshold,
  type MemoryScope,
  maybeConsolidateGlobalMemory,
  maybeConsolidateUserMemory,
  pendingCount,
  proposeGlobalFacts,
  proposeUserFacts,
  searchMemoryFacts,
} from "./memory-store.js";

/** Identity of the session calling a memory tool, for scope enforcement. */
export interface MemoryToolContext {
  sessionName: string;
  /** Slack user ID — only set for DM sessions. */
  userId?: string;
  /** LLM caller used to consolidate a scope once its inbox fills up. */
  consolidateLlm?: (prompt: string) => Promise<string>;
}

const MAX_FACT_CHARS = 300;
const DEFAULT_LIMIT = 20;

function enabled(): boolean {
  return process.env.USE_MEMORY_TOOLS === "true";
}

const DISABLED_MESSAGE =
  "Shared memory tools are not enabled. Set USE_MEMORY_TOOLS=true to use this tool.";

function text(body: string): AgentToolResult<undefined> {
  return { content: [{ type: "text", text: body }], details: undefined };
}

/**
 * Resolve a requested scope name against what this session may touch.
 * Returns an error string instead of throwing so tools can report it as
 * normal tool output rather than a crash.
 */
function resolveScope(
  ctx: MemoryToolContext,
  requested: "global" | "user",
): { scope: MemoryScope } | { error: string } {
  if (requested === "global") return { scope: { kind: "global" } };
  const isDm = ctx.sessionName.startsWith("@");
  if (!isDm) {
    return {
      error:
        'User-scoped memory is only accessible in a direct message. In a channel, use scope "global".',
    };
  }
  if (!ctx.userId) {
    return {
      error:
        "No Slack user ID is associated with this session, so user memory is unavailable.",
    };
  }
  return { scope: { kind: "user", userId: ctx.userId } };
}

// ============================================================================
// memory_query
// ============================================================================

const memoryQuerySchema = Type.Object({
  action: Type.Union([Type.Literal("search"), Type.Literal("list")], {
    description:
      "'search' ranks facts against query; 'list' returns all facts in a scope",
  }),
  scope: Type.Optional(
    Type.Union(
      [Type.Literal("global"), Type.Literal("user"), Type.Literal("all")],
      {
        description:
          "'global' = facts shared across every session, 'user' = facts about the person in this DM, 'all' = both (default)",
      },
    ),
  ),
  query: Type.Optional(
    Type.String({ description: "Search text; required for action 'search'" }),
  ),
  limit: Type.Optional(
    Type.Number({
      description: `Max facts per scope (default ${DEFAULT_LIMIT})`,
    }),
  ),
});

export function createMemoryQueryTool(
  ctx: MemoryToolContext,
): AgentTool<typeof memoryQuerySchema, undefined> {
  return {
    name: "memory_query",
    label: "Query Memory",
    description:
      "Search or list durable facts from shared memory. Global memory is already injected into your system prompt — use this to look deeper, to check what is remembered before writing, or to read user memory in a DM.",
    parameters: memoryQuerySchema,
    execute: async (_id, params): Promise<AgentToolResult<undefined>> => {
      if (!enabled()) return text(DISABLED_MESSAGE);

      const requested = params.scope ?? "all";
      const query = params.query?.trim() ?? "";
      if (params.action === "search" && !query) {
        return text("action 'search' requires a non-empty query.");
      }
      const limit = Math.max(1, Math.min(params.limit ?? DEFAULT_LIMIT, 100));

      const wanted: Array<"global" | "user"> =
        requested === "all" ? ["global", "user"] : [requested];

      const sections: string[] = [];
      for (const name of wanted) {
        const resolved = resolveScope(ctx, name);
        if ("error" in resolved) {
          // With scope 'all', a channel session simply has no user scope —
          // that is expected, not an error worth reporting.
          if (requested !== "all") return text(resolved.error);
          continue;
        }
        const facts = await searchMemoryFacts(resolved.scope, query, limit);
        const label = name === "global" ? "Global memory" : "User memory";
        sections.push(
          facts.length
            ? `## ${label}\n${facts.map((f) => `- ${f}`).join("\n")}`
            : `## ${label}\n(no matching facts)`,
        );
      }

      if (sections.length === 0)
        return text("No memory scopes are accessible from this session.");
      return text(sections.join("\n\n"));
    },
  };
}

// ============================================================================
// memory_write
// ============================================================================

const memoryWriteSchema = Type.Object({
  facts: Type.Array(Type.String(), {
    description:
      "Durable facts to remember, one per entry. Keep each to a single short sentence.",
  }),
  scope: Type.Union([Type.Literal("global"), Type.Literal("user")], {
    description:
      "'global' = useful in every session; 'user' = about the person in this DM (DM only)",
  }),
});

export function createMemoryWriteTool(
  ctx: MemoryToolContext,
): AgentTool<typeof memoryWriteSchema, undefined> {
  return {
    name: "memory_write",
    label: "Write Memory",
    description:
      "Propose durable facts for shared memory. Facts enter a review inbox and are merged into memory by a later consolidation pass, so they will not appear immediately. Use only for information that stays true across sessions — not one-off tasks or session chatter.",
    parameters: memoryWriteSchema,
    execute: async (_id, params): Promise<AgentToolResult<undefined>> => {
      if (!enabled()) return text(DISABLED_MESSAGE);

      const facts = params.facts
        .map((f) => f.trim())
        .filter(Boolean)
        .map((f) =>
          f.length > MAX_FACT_CHARS ? `${f.slice(0, MAX_FACT_CHARS)}…` : f,
        );
      if (facts.length === 0)
        return text("No facts provided — nothing written.");

      const resolved = resolveScope(ctx, params.scope);
      if ("error" in resolved) return text(resolved.error);
      const { scope } = resolved;

      const timestamp = new Date().toISOString();
      const proposals = facts.map((t) => ({
        text: t,
        sourceSession: ctx.sessionName,
        timestamp,
      }));

      if (scope.kind === "global") {
        await proposeGlobalFacts(proposals);
      } else {
        await proposeUserFacts(scope.userId, proposals);
      }

      const pending = await pendingCount(scope);
      const threshold = consolidateThreshold(scope);

      // Consolidation is an LLM call; never let it block or fail the tool.
      if (ctx.consolidateLlm && pending >= threshold) {
        const llm = ctx.consolidateLlm;
        const run =
          scope.kind === "global"
            ? maybeConsolidateGlobalMemory(llm)
            : maybeConsolidateUserMemory(scope.userId, llm);
        run.catch((err) => {
          console.warn(
            `[memory-tools] WARNING: Consolidation after write failed: ${err}`,
          );
        });
      }

      const where = scope.kind === "global" ? "global" : "user";
      return text(
        `Queued ${facts.length} fact(s) for ${where} memory. ` +
          `${pending}/${threshold} facts pending; they merge into memory once the inbox reaches ${threshold}.`,
      );
    },
  };
}

export function createMemoryTools(ctx: MemoryToolContext): AgentTool<any>[] {
  return [createMemoryQueryTool(ctx), createMemoryWriteTool(ctx)];
}
