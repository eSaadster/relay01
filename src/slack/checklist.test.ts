import { describe, expect, it } from "vitest";

import { type Step, renderStepChecklist } from "./checklist.js";

describe("renderStepChecklist", () => {
  it("maps each state to its icon", () => {
    const steps: Step[] = [
      { label: "Reading file", state: "run" },
      { label: "Writing file", state: "ok" },
      { label: "Searching web", state: "err" },
    ];
    expect(renderStepChecklist(steps)).toBe(
      "🔄 Reading file\n✅ Writing file\n❌ Searching web",
    );
  });

  it("renders an empty checklist as an empty string", () => {
    expect(renderStepChecklist([])).toBe("");
  });
});

// Mirror the accumulation logic used in main.ts to verify checklist behavior.
function applyActivity(
  steps: Step[],
  e: { phase: "start" | "end"; label: string; isError?: boolean },
): void {
  if (e.phase === "start") {
    steps.push({ label: e.label, state: "run" });
  } else {
    const s = [...steps].reverse().find((x) => x.label === e.label && x.state === "run");
    if (s) s.state = e.isError ? "err" : "ok";
  }
}

describe("checklist accumulation", () => {
  it("start adds a running step", () => {
    const steps: Step[] = [];
    applyActivity(steps, { phase: "start", label: "Reading file" });
    expect(steps).toEqual([{ label: "Reading file", state: "run" }]);
  });

  it("end marks the matching running step ok", () => {
    const steps: Step[] = [];
    applyActivity(steps, { phase: "start", label: "Reading file" });
    applyActivity(steps, { phase: "end", label: "Reading file", isError: false });
    expect(steps).toEqual([{ label: "Reading file", state: "ok" }]);
  });

  it("end marks the matching running step err on failure", () => {
    const steps: Step[] = [];
    applyActivity(steps, { phase: "start", label: "Running command" });
    applyActivity(steps, { phase: "end", label: "Running command", isError: true });
    expect(steps).toEqual([{ label: "Running command", state: "err" }]);
  });

  it("end resolves the most-recent running step with the same label", () => {
    const steps: Step[] = [];
    applyActivity(steps, { phase: "start", label: "Reading file" });
    applyActivity(steps, { phase: "start", label: "Reading file" });
    applyActivity(steps, { phase: "end", label: "Reading file", isError: false });
    expect(steps).toEqual([
      { label: "Reading file", state: "run" },
      { label: "Reading file", state: "ok" },
    ]);
  });

  it("ignores an end with no matching running step", () => {
    const steps: Step[] = [{ label: "Reading file", state: "ok" }];
    applyActivity(steps, { phase: "end", label: "Reading file", isError: false });
    expect(steps).toEqual([{ label: "Reading file", state: "ok" }]);
  });
});
