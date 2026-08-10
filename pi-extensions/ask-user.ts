/**
 * ask_user — pi extension giving background agents a way to ask the human
 * a question mid-run. In RPC mode ctx.ui.input()/select() emit a blocking
 * extension_ui_request on stdout; the klaus-slack runner forwards it to
 * Slack and writes the answer back as an extension_ui_response.
 *
 * Loaded via `pi --extension <this file>` by src/auto-reply/agents/runner.ts.
 * This file is compiled by pi's extension loader, not by this repo's tsconfig.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

const DEFAULT_TIMEOUT_SEC = 900;

const ASK_USER_PARAMS = Type.Object({
  question: Type.String({
    description: "The question to ask the user. Be specific and concise.",
  }),
  options: Type.Optional(
    Type.Array(Type.String(), {
      description:
        "Optional multiple-choice options. If given, the user picks one.",
    }),
  ),
  timeoutSec: Type.Optional(
    Type.Number({
      description: `Seconds to wait for an answer (default ${DEFAULT_TIMEOUT_SEC}). On timeout the tool returns "(no answer)".`,
    }),
  ),
});

export default function askUserExtension(pi: ExtensionAPI) {
  // pi-rlm collapses the tool surface to ["execute"] on session_start; re-add
  // ask_user so it survives regardless of extension load order. Hook
  // before_agent_start too so it's restored before every LLM call.
  const ensureActive = () => {
    const active = pi.getActiveTools();
    if (!active.includes("ask_user")) {
      pi.setActiveTools([...active, "ask_user"]);
    }
  };
  pi.on("session_start", async () => ensureActive());
  pi.on("before_agent_start", async () => ensureActive());

  pi.registerTool({
    name: "ask_user",
    label: "Ask User",
    description:
      "Ask the human user a question and wait for their reply. Use this when you " +
      "need clarification, a decision, or missing information before proceeding — " +
      "instead of guessing. Blocks until the user answers or the timeout expires.",
    parameters: ASK_USER_PARAMS,
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const timeout =
        Math.max(10, params.timeoutSec ?? DEFAULT_TIMEOUT_SEC) * 1000;

      let answer: string | undefined;
      if (params.options && params.options.length > 0) {
        answer = await ctx.ui.select(params.question, params.options, {
          timeout,
        });
      } else {
        answer = await ctx.ui.input(params.question, undefined, { timeout });
      }

      return {
        content: [
          {
            type: "text",
            text:
              answer !== undefined && answer !== ""
                ? `User answered: ${answer}`
                : "(no answer — the question timed out or was dismissed; proceed with your best judgment and note the assumption)",
          },
        ],
        details: undefined,
      };
    },
  });
}
