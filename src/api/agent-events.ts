import { EventEmitter } from "node:events";

export type AgentStreamEvent = {
  session: string;
  seq: number;
  phase: "start" | "end" | "final";
  toolName?: string;
  label?: string;
  isError?: boolean;
  durationMs?: number;
  ts: number;
};

const bus = new EventEmitter();
bus.setMaxListeners(0);

export function emitAgentEvent(e: AgentStreamEvent) {
  bus.emit("event", e);
}

export function onAgentEvent(fn: (e: AgentStreamEvent) => void): () => void {
  bus.on("event", fn);
  return () => {
    bus.off("event", fn);
  };
}
