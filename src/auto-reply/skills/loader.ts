// Skills initialization and loading

import { logVerbose } from "../../globals.js";
import { getSkillRegistry } from "./registry.js";

/**
 * Load built-in programmatic skills.
 * Add new built-in skills here as they are created.
 */
async function loadBuiltinSkills(): Promise<void> {
  const registry = getSkillRegistry();

  // DigitalOcean App Platform skill
  const { digitaloceanSkill } = await import("./builtin/digitalocean.js");
  registry.register(digitaloceanSkill);
  logVerbose("Registered digitalocean skill");
}

/**
 * Initialize the skills system.
 * Call this once at application startup.
 */
export async function initializeSkills(): Promise<void> {
  logVerbose("Initializing skills system...");

  // Load built-in programmatic skills
  await loadBuiltinSkills();

  const registry = getSkillRegistry();
  const skills = registry.getAll();
  logVerbose(`Skills system initialized with ${skills.length} programmatic skills`);
}
