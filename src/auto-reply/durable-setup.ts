import { loadSessionEnv } from "../index.js";
import type { DurableSetup } from "./durable.js";
import { DEFAULT_MODEL, findModel, loadSystemPrompt } from "./pi-agent.js";
import { callSummarizerWithAgent } from "./pi-agent-summarizer.js";
import {
  type CanvasCallbacks,
  createTools,
  SLACK_BASE_PATH,
} from "./pi-agent-tools.js";
import { discoverConventionSkills, getSkillRegistry } from "./skills/index.js";

export interface SetupOptions {
  isDm: boolean;
  userId?: string;
  model?: string;
  thinkingLevel?: string;
  notify?: (message: string) => Promise<void>;
  channelId?: string;
  canvas?: CanvasCallbacks;
}

export async function buildDurableSetup(
  folder: string,
  options: SetupOptions,
): Promise<DurableSetup> {
  loadSessionEnv(folder);
  const configured = process.env.PI_AGENT_MODEL || options.model;
  const found =
    (configured ? await findModel(configured) : null) ??
    (await findModel(DEFAULT_MODEL));
  if (!found) throw new Error(`Default model ${DEFAULT_MODEL} not found`);
  const sessionInfo = `\nYour working directory (scratchpad): ~/relay01/slack/${folder}/scratchpad/\nSave important user info, preferences, and #memory items to session.md.\n`;
  let systemPrompt = sessionInfo + (await loadSystemPrompt(folder));
  const conventionSkills = await discoverConventionSkills({
    workspacePath: SLACK_BASE_PATH,
    sessionName: folder,
  });
  if (conventionSkills.systemPromptSection)
    systemPrompt += `\n\n${conventionSkills.systemPromptSection}`;
  const registry = getSkillRegistry();
  const additions = registry.getSystemPromptAdditions();
  if (additions) systemPrompt += `\n\n${additions}`;
  const tools = [
    ...createTools(folder, {
      notify: options.notify,
      channelId: options.channelId,
      canvas: options.canvas,
      userId: options.isDm ? options.userId : undefined,
      consolidateLlm: callSummarizerWithAgent,
    }),
    ...registry.getAllTools(),
  ];
  return {
    model: found.model,
    thinkingLevel: options.thinkingLevel,
    systemPrompt,
    tools,
  };
}
