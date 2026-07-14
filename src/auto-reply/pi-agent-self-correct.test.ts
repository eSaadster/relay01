import type { AgentEvent } from "@earendil-works/pi-agent-core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { PiAgentManager } from "./pi-agent.js";

interface AttemptScript {
  toolFailures?: Array<{
    toolName: string;
    toolCallId: string;
    result?: unknown;
  }>;
  assistantText?: string;
  rejectWith?: Error;
}

class FakeAgent {
  state = {
    messages: [] as Array<{
      role: "assistant";
      content: Array<{ type: "text"; text: string }>;
    }>,
  };

  promptCalls: string[] = [];
  private subscribers: Array<(event: AgentEvent) => void> = [];

  constructor(private scripts: AttemptScript[]) {}

  subscribe(handler: (event: AgentEvent) => void): () => void {
    this.subscribers.push(handler);
    return () => {
      this.subscribers = this.subscribers.filter((s) => s !== handler);
    };
  }

  async prompt(promptMessage: string): Promise<void> {
    this.promptCalls.push(promptMessage);
    const script = this.scripts[this.promptCalls.length - 1] ?? {};

    for (const failure of script.toolFailures ?? []) {
      this.emit({
        type: "tool_execution_end",
        toolName: failure.toolName,
        toolCallId: failure.toolCallId,
        result: failure.result,
        isError: true,
      });
    }

    if (script.assistantText !== undefined) {
      this.state.messages.push({
        role: "assistant",
        content: [{ type: "text", text: script.assistantText }],
      });
    }

    if (script.rejectWith) {
      throw script.rejectWith;
    }
  }

  async waitForIdle(): Promise<void> {}

  abort(): void {}

  private emit(event: AgentEvent): void {
    for (const subscriber of this.subscribers) {
      subscriber(event);
    }
  }
}

interface TestableManager {
  agents: Map<
    string,
    { agent: FakeAgent; lastActivity: number; messageCount: number }
  >;
  getOrCreateAgent: (
    sessionName: string,
  ) => Promise<{ agent: FakeAgent; isNew: boolean }>;
}

function attachFakeAgent(
  manager: PiAgentManager,
  sessionName: string,
  agent: FakeAgent,
): void {
  const testManager = manager as unknown as TestableManager;
  testManager.agents.set(sessionName, {
    agent,
    lastActivity: Date.now(),
    messageCount: 0,
  });
  testManager.getOrCreateAgent = vi.fn(async () => ({ agent, isNew: false }));
}

describe("PiAgentManager self-correction loop", () => {
  const originalSelfCorrect = process.env.SELF_CORRECT;

  beforeEach(() => {
    delete process.env.SELF_CORRECT;
  });

  afterEach(() => {
    if (originalSelfCorrect === undefined) {
      delete process.env.SELF_CORRECT;
    } else {
      process.env.SELF_CORRECT = originalSelfCorrect;
    }
    vi.clearAllMocks();
  });

  it("retries failed tool calls and returns repair answer when repair succeeds", async () => {
    const sessionName = "@self-correct-repair-success";
    const agent = new FakeAgent([
      {
        toolFailures: [
          {
            toolName: "weather_lookup",
            toolCallId: "call-1",
            result: { error: "timeout" },
          },
        ],
        assistantText: "",
      },
      {
        assistantText: "Repaired final answer",
      },
    ]);
    const manager = new PiAgentManager({ selfCorrect: true });
    attachFakeAgent(manager, sessionName, agent);

    const result = await manager.prompt(
      sessionName,
      "What is the weather right now?",
    );

    expect(result.text).toBe("Repaired final answer");
    expect(agent.promptCalls).toHaveLength(2);
    expect(agent.promptCalls[1]).toContain(
      "User message:\nWhat is the weather right now?",
    );
    expect(agent.promptCalls[1]).toContain(
      '- weather_lookup (call-1): {"error":"timeout"}',
    );
    expect(agent.promptCalls[1]).toContain(
      "Retry only the failed tool calls and return a final answer.",
    );
  });

  it("returns fallback text when repair attempt also fails", async () => {
    const sessionName = "@self-correct-repair-fail";
    const agent = new FakeAgent([
      {
        toolFailures: [
          {
            toolName: "weather_lookup",
            toolCallId: "call-1",
            result: "primary failed",
          },
        ],
        assistantText: "",
      },
      {
        toolFailures: [
          {
            toolName: "weather_lookup",
            toolCallId: "call-2",
            result: "repair failed",
          },
        ],
        assistantText: "",
      },
    ]);
    const manager = new PiAgentManager({ selfCorrect: true });
    attachFakeAgent(manager, sessionName, agent);

    const result = await manager.prompt(
      sessionName,
      "Try weather lookup again",
    );

    expect(result.text).toBe(
      "I couldn't complete that request. Please try again.",
    );
    expect(agent.promptCalls).toHaveLength(2);
  });

  it("retries with extended timeout when primary attempt times out", async () => {
    const sessionName = "@self-correct-timeout-recovery";
    const agent = new FakeAgent([
      {
        rejectWith: new Error("Agent timeout"),
      },
      {
        assistantText: "Recovered after timeout",
      },
    ]);
    const manager = new PiAgentManager({ selfCorrect: true });
    attachFakeAgent(manager, sessionName, agent);

    const result = await manager.prompt(
      sessionName,
      "Do something slow",
    );

    expect(result.text).toBe("Recovered after timeout");
    expect(agent.promptCalls).toHaveLength(2);
    expect(agent.promptCalls[1]).toContain(
      "The previous attempt timed out before completing.",
    );
    expect(agent.promptCalls[1]).toContain(
      "User message:\nDo something slow",
    );
  });

  it("throws when primary times out and selfCorrect is disabled", async () => {
    const sessionName = "@self-correct-timeout-no-repair";
    const agent = new FakeAgent([
      {
        rejectWith: new Error("Agent timeout"),
      },
    ]);
    const manager = new PiAgentManager({ selfCorrect: false });
    attachFakeAgent(manager, sessionName, agent);

    await expect(
      manager.prompt(sessionName, "Do something slow"),
    ).rejects.toThrow("Agent timeout");
    expect(agent.promptCalls).toHaveLength(1);
  });
});
