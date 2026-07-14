export type StepState = "run" | "ok" | "err";
export interface Step {
  label: string;
  state: StepState;
}

const ICON: Record<StepState, string> = { run: "🔄", ok: "✅", err: "❌" };

export function renderStepChecklist(steps: Step[]): string {
  return steps.map((s) => `${ICON[s.state]} ${s.label}`).join("\n");
}
