// Agent definition discovery

import * as fs from "node:fs/promises";
import os from "node:os";
import * as path from "node:path";
import { logVerbose } from "../../globals.js";
import type {
  AgentDefinition,
  AgentDefinitionFrontmatter,
  ChainDefinition,
  ChainStep,
  DiscoveredDefinitions,
} from "./types.js";

// ─── Path helpers ───────────────────────────────────────────────────────────

/**
 * Expand ~ to home directory.
 */
export function expandPath(p: string): string {
  if (p.startsWith("~/")) {
    return path.join(process.env.HOME || os.homedir(), p.slice(2));
  }
  return p;
}

// ─── Frontmatter parsing ────────────────────────────────────────────────────

/**
 * Parse frontmatter from markdown content.
 */
function parseFrontmatter(content: string): {
  frontmatter: Record<string, unknown>;
  body: string;
} {
  const frontmatterRegex = /^---\n([\s\S]*?)\n---\n([\s\S]*)$/;
  const match = content.match(frontmatterRegex);

  if (!match) {
    return { frontmatter: {}, body: content };
  }

  const [, frontmatterStr, body] = match;
  const frontmatter: Record<string, unknown> = {};

  for (const line of frontmatterStr.split("\n")) {
    const kvMatch = line.match(/^(\w+):\s*(.*)$/);
    if (kvMatch) {
      const [, key, value] = kvMatch;
      if (value.startsWith('"') && value.endsWith('"')) {
        frontmatter[key] = value.slice(1, -1);
      } else if (value === "true") {
        frontmatter[key] = true;
      } else if (value === "false") {
        frontmatter[key] = false;
      } else if (/^\d+$/.test(value)) {
        frontmatter[key] = parseInt(value, 10);
      } else {
        frontmatter[key] = value;
      }
    }
  }

  return { frontmatter, body: body.trim() };
}

/**
 * Validate frontmatter into AgentDefinitionFrontmatter.
 * Permissive: unknown keys are ignored, no fatal errors.
 */
function validateFrontmatter(
  raw: Record<string, unknown>,
): AgentDefinitionFrontmatter {
  return {
    timeout: typeof raw.timeout === "string" ? raw.timeout : undefined,
    cwd: typeof raw.cwd === "string" ? raw.cwd : undefined,
    model: typeof raw.model === "string" ? raw.model : undefined,
  };
}

// ─── Chain parsing ──────────────────────────────────────────────────────────

/**
 * Parse a *.chain.md file into a ChainDefinition.
 *
 * Format:
 * ---
 * timeout: 1h
 * ---
 * ## Step: step-name
 * Prompt text with {task} and {previous}
 *
 * ## Step: another-step (on_failure: continue)
 * Another prompt
 */
export function parseChainDefinition(
  id: string,
  filePath: string,
  content: string,
): ChainDefinition | { error: string } {
  const { frontmatter, body } = parseFrontmatter(content);
  const config = validateFrontmatter(frontmatter);

  const steps: ChainStep[] = [];
  // Split by ## Step: headers
  const stepRegex = /^## Step:\s*(\S+)(?:\s*\(([^)]*)\))?\s*$/gm;
  let lastIndex = 0;
  let lastStep: { name: string; onFailure?: "stop" | "continue" } | null =
    null;

  for (const match of body.matchAll(stepRegex)) {
    // Save previous step's prompt
    if (lastStep) {
      const prompt = body.slice(lastIndex, match.index).trim();
      steps.push({ ...lastStep, prompt });
    }

    const name = match[1];
    const options = match[2]?.trim();
    const onFailure =
      options?.includes("on_failure: continue") ? "continue" : undefined;
    lastStep = { name, onFailure };
    lastIndex = (match.index ?? 0) + match[0].length;
  }

  // Save last step
  if (lastStep) {
    const prompt = body.slice(lastIndex).trim();
    steps.push({ ...lastStep, prompt });
  }

  if (steps.length === 0) {
    return { error: "Chain definition has no steps" };
  }

  return { id, path: filePath, config, steps };
}

// ─── Discovery ──────────────────────────────────────────────────────────────

/**
 * Discover definitions from a single directory.
 * Supports:
 * 1. Single .md file: definitions/research.md
 * 2. Directory with template.md: definitions/research/template.md
 * 3. Chain files: definitions/pipeline.chain.md
 */
async function discoverDefinitionsFromDir(dirPath: string): Promise<{
  definitions: AgentDefinition[];
  errors: Array<{ path: string; error: string }>;
}> {
  const definitions: AgentDefinition[] = [];
  const errors: Array<{ path: string; error: string }> = [];

  try {
    await fs.access(dirPath);
  } catch {
    return { definitions, errors };
  }

  try {
    const entries = await fs.readdir(dirPath, { withFileTypes: true });

    for (const entry of entries) {
      // Chain file: pipeline.chain.md
      if (entry.isFile() && entry.name.endsWith(".chain.md")) {
        const filePath = path.join(dirPath, entry.name);
        const id = entry.name.replace(/\.chain\.md$/, "");

        try {
          const content = await fs.readFile(filePath, "utf-8");
          const result = parseChainDefinition(id, filePath, content);

          if ("error" in result) {
            errors.push({ path: filePath, error: result.error });
            continue;
          }

          // Wrap chain as an AgentDefinition with isChain=true
          definitions.push({
            id,
            path: filePath,
            config: result.config,
            instructions: JSON.stringify(result.steps),
            isChain: true,
          });

          logVerbose(
            `[agents/discovery] Loaded chain definition: ${id} (${result.steps.length} steps)`,
          );
        } catch (err) {
          errors.push({
            path: filePath,
            error: err instanceof Error ? err.message : String(err),
          });
        }
        continue;
      }

      // Single .md file (not chain)
      if (entry.isFile() && entry.name.endsWith(".md")) {
        const filePath = path.join(dirPath, entry.name);
        const id = entry.name.replace(/\.md$/, "");

        try {
          const content = await fs.readFile(filePath, "utf-8");
          const { frontmatter, body } = parseFrontmatter(content);
          const config = validateFrontmatter(frontmatter);

          definitions.push({
            id,
            path: filePath,
            config,
            instructions: body,
            isChain: false,
          });

          logVerbose(
            `[agents/discovery] Loaded definition: ${id} from ${filePath}`,
          );
        } catch (err) {
          errors.push({
            path: filePath,
            error: err instanceof Error ? err.message : String(err),
          });
        }
        continue;
      }

      // Directory with template.md
      if (entry.isDirectory()) {
        const templateDir = path.join(dirPath, entry.name);
        const templateFile = path.join(templateDir, "template.md");
        const id = entry.name;

        try {
          const content = await fs.readFile(templateFile, "utf-8");
          const { frontmatter, body } = parseFrontmatter(content);
          const config = validateFrontmatter(frontmatter);

          // Check for mcporter.json
          const mcpConfigPath = path.join(templateDir, "mcporter.json");
          let hasMcpConfig = false;
          try {
            await fs.access(mcpConfigPath);
            hasMcpConfig = true;
            logVerbose(`[agents/discovery] Definition ${id} has MCP config`);
          } catch {
            // No MCP config
          }

          definitions.push({
            id,
            path: templateFile,
            config,
            instructions: body,
            isChain: false,
            mcpConfigPath: hasMcpConfig ? mcpConfigPath : undefined,
          });

          logVerbose(
            `[agents/discovery] Loaded definition: ${id} from ${templateDir}`,
          );
        } catch {
          // template.md not found in directory, skip silently
        }
      }
    }
  } catch (err) {
    errors.push({
      path: dirPath,
      error: err instanceof Error ? err.message : String(err),
    });
  }

  return { definitions, errors };
}

/**
 * Discover all agent definitions from a directory.
 */
export async function discoverDefinitions(
  definitionsPath: string,
): Promise<DiscoveredDefinitions> {
  const expandedPath = expandPath(definitionsPath);
  const result = await discoverDefinitionsFromDir(expandedPath);

  logVerbose(
    `[agents/discovery] Found ${result.definitions.length} definitions, ${result.errors.length} errors`,
  );

  return result;
}

/**
 * Load a specific definition by ID.
 */
export async function loadDefinition(
  definitionsPath: string,
  definitionId: string,
): Promise<AgentDefinition | null> {
  const expandedPath = expandPath(definitionsPath);

  // Try .md file first
  const filePath = path.join(expandedPath, `${definitionId}.md`);
  try {
    const content = await fs.readFile(filePath, "utf-8");
    const { frontmatter, body } = parseFrontmatter(content);
    const config = validateFrontmatter(frontmatter);

    return {
      id: definitionId,
      path: filePath,
      config,
      instructions: body,
      isChain: false,
    };
  } catch {
    // Not found as .md, try .chain.md
  }

  // Try .chain.md
  const chainPath = path.join(expandedPath, `${definitionId}.chain.md`);
  try {
    const content = await fs.readFile(chainPath, "utf-8");
    const result = parseChainDefinition(definitionId, chainPath, content);
    if ("error" in result) {
      logVerbose(
        `[agents/discovery] Invalid chain ${definitionId}: ${result.error}`,
      );
      return null;
    }
    return {
      id: definitionId,
      path: chainPath,
      config: result.config,
      instructions: JSON.stringify(result.steps),
      isChain: true,
    };
  } catch {
    // Not found
  }

  // Try directory format
  const dirPath = path.join(expandedPath, definitionId, "template.md");
  try {
    const content = await fs.readFile(dirPath, "utf-8");
    const { frontmatter, body } = parseFrontmatter(content);
    const config = validateFrontmatter(frontmatter);

    return {
      id: definitionId,
      path: dirPath,
      config,
      instructions: body,
      isChain: false,
    };
  } catch {
    logVerbose(`[agents/discovery] Definition not found: ${definitionId}`);
    return null;
  }
}

/**
 * Create an ad-hoc definition for agent runs without a specific definition.
 */
export function createAdHocDefinition(userPrompt: string): AgentDefinition {
  return {
    id: "ad-hoc",
    path: "(generated)",
    config: {
      timeout: "30m",
      model: "glm-4.7",
    },
    instructions: `# Ad-hoc Agent Task

Execute the user's request autonomously, working to completion.

## User Request
${userPrompt}

## Instructions
1. Analyze the task and determine the best approach
2. Execute the required steps
3. If errors occur, attempt to fix them
4. Report results when complete
`,
    isChain: false,
  };
}
