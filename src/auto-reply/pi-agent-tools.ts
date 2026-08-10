// Tools for pi-agent - filesystem, bash, search, web search
// These tools give the agent capabilities similar to the pi CLI

import { execSync, spawn } from "node:child_process";
import fs from "node:fs/promises";
import fsSync from "node:fs";
import path from "node:path";
import os from "node:os";

import { Type, type Static } from "@sinclair/typebox";
import type { AgentTool, AgentToolResult } from "@earendil-works/pi-agent-core";
import type { TextContent, ImageContent } from "@earendil-works/pi-ai";

import { dslToBlocks, type UiSpec } from "../slack/blocks.js";

// Base path for all Slack sessions
export const SLACK_BASE_PATH = path.join(os.homedir(), "relay01", "slack");

// Anthropic blocks specific lowercase tool names (bash, read, write, edit) when using OAuth tokens.
// Rename them to capitalized versions for compatibility with both OAuth and API keys.
const OAUTH_BLOCKED_TOOL_NAMES: Record<string, string> = {
  bash: "Bash",
  read: "Read",
  write: "Write",
  edit: "Edit",
  read_file: "Read_file",
};

function renameBlockedToolsForOAuth(tools: AgentTool<any>[]): AgentTool<any>[] {
  return tools.map((tool) => {
    const newName = OAUTH_BLOCKED_TOOL_NAMES[tool.name];
    if (newName) {
      return { ...tool, name: newName };
    }
    return tool;
  });
}

/**
 * Session context - passed to tool factory to avoid global state race conditions.
 * Each agent gets its own context captured in closures.
 */
export interface SessionContext {
  sessionName: string;
  sessionCwd: string;
  sessionRoot: string;
}

/**
 * Create session context for a given session name.
 * Ensures the scratchpad directory exists.
 */
export function createSessionContext(sessionName: string): SessionContext {
  const sessionRoot = path.join(SLACK_BASE_PATH, sessionName);
  const sessionCwd = path.join(sessionRoot, "scratchpad");
  // Ensure scratchpad exists
  try {
    fsSync.mkdirSync(sessionCwd, { recursive: true });
  } catch {
    // ignore
  }
  return { sessionName, sessionCwd, sessionRoot };
}

/**
 * Create a sandboxPath function bound to a specific session context.
 * This avoids the global state race condition.
 */
function createSandboxPath(ctx: SessionContext) {
  return (inputPath: string, allowSkills = false, allowSessionRoot = false): string => {
    const resolved = path.isAbsolute(inputPath)
      ? path.resolve(inputPath)
      : path.resolve(path.join(ctx.sessionCwd, inputPath));

    // Allow access to scratchpad
    if (resolved.startsWith(ctx.sessionCwd + path.sep) || resolved === ctx.sessionCwd) {
      return resolved;
    }

    // Allow write access to session root (excluding protected paths)
    if (allowSessionRoot) {
      if (resolved.startsWith(ctx.sessionRoot + path.sep) || resolved === ctx.sessionRoot) {
        const relative = path.relative(ctx.sessionRoot, resolved);
        if (relative === "SYSTEM.md" || relative === "skills" || relative.startsWith("skills" + path.sep)) {
          throw new Error(`Access denied: cannot write to protected path (${relative})`);
        }
        return resolved;
      }
    }

    // Allow read-only access to skills directories
    if (allowSkills) {
      const globalSkillsDir = path.join(SLACK_BASE_PATH, "skills");
      const sessionSkillsDir = path.join(ctx.sessionRoot, "skills");

      if (resolved.startsWith(globalSkillsDir + path.sep) || resolved === globalSkillsDir ||
          resolved.startsWith(sessionSkillsDir + path.sep) || resolved === sessionSkillsDir) {
        return resolved;
      }
    }

    throw new Error(`Access denied: path outside sandbox (${resolved})`);
  };
}

// Ensure base path exists
try {
  fsSync.mkdirSync(SLACK_BASE_PATH, { recursive: true });
} catch {
  // ignore
}

// ============================================================================
// Read File Tool
// ============================================================================

const readFileSchema = Type.Object({
  path: Type.String({ description: "Path to the file to read (relative to your scratchpad)" }),
  maxLines: Type.Optional(Type.Number({ description: "Maximum number of lines to read (default: 500)" })),
});

function createReadFileTool(ctx: SessionContext): AgentTool<typeof readFileSchema, undefined> {
  const sandboxPath = createSandboxPath(ctx);
  return {
    name: "read_file",
    label: "Read File",
    description: "Read the contents of a file from your scratchpad or skills directories. Paths are relative to your scratchpad directory.",
    parameters: readFileSchema,
    execute: async (_toolCallId, params): Promise<AgentToolResult<undefined>> => {
      try {
        const filePath = sandboxPath(params.path, true); // allowSkills=true for reading
        console.log(`[read_file] Reading: ${filePath}`);
        const content = await fs.readFile(filePath, "utf8");
        const lines = content.split("\n");
        const maxLines = params.maxLines ?? 500;
        const truncated = lines.length > maxLines;
        const result = truncated ? lines.slice(0, maxLines).join("\n") : content;

        return {
          content: [{
            type: "text",
            text: truncated
              ? `${result}\n\n... [truncated, showing ${maxLines} of ${lines.length} lines]`
              : result,
          }],
          details: undefined,
        };
      } catch (err) {
        return {
          content: [{ type: "text", text: `Error reading file: ${err}` }],
          details: undefined,
        };
      }
    },
  };
}

// ============================================================================
// Write File Tool
// ============================================================================

const writeFileSchema = Type.Object({
  path: Type.String({ description: "Path where to write the file (relative to your scratchpad)" }),
  content: Type.String({ description: "Content to write to the file" }),
});

function createWriteFileTool(ctx: SessionContext): AgentTool<typeof writeFileSchema, undefined> {
  const sandboxPath = createSandboxPath(ctx);
  return {
    name: "write_file",
    label: "Write File",
    description: "Write content to a file in your scratchpad or session directory. Creates the file if it doesn't exist, overwrites if it does. Can write config files (clicks.json, mcporter.json) to the session root. Cannot write to SYSTEM.md or skills/.",
    parameters: writeFileSchema,
    execute: async (_toolCallId, params): Promise<AgentToolResult<undefined>> => {
      try {
        const filePath = sandboxPath(params.path, false, true);
        console.log(`[write_file] Writing ${params.content.length} bytes to: ${filePath}`);

        // Ensure parent directory exists
        await fs.mkdir(path.dirname(filePath), { recursive: true });
        await fs.writeFile(filePath, params.content, "utf8");

        return {
          content: [{ type: "text", text: `Successfully wrote ${params.content.length} bytes to ${filePath}` }],
          details: undefined,
        };
      } catch (err) {
        return {
          content: [{ type: "text", text: `Error writing file: ${err}` }],
          details: undefined,
        };
      }
    },
  };
}

// ============================================================================
// List Directory Tool
// ============================================================================

const listDirSchema = Type.Object({
  path: Type.Optional(Type.String({ description: "Directory path to list (default: scratchpad)" })),
  recursive: Type.Optional(Type.Boolean({ description: "List recursively (default: false)" })),
});

function createListDirTool(ctx: SessionContext): AgentTool<typeof listDirSchema, undefined> {
  const sandboxPath = createSandboxPath(ctx);
  return {
    name: "list_directory",
    label: "List Directory",
    description: "List files and directories in your scratchpad or skills directories.",
    parameters: listDirSchema,
    execute: async (_toolCallId, params): Promise<AgentToolResult<undefined>> => {
      try {
        const dirPath = params.path ? sandboxPath(params.path, true) : ctx.sessionCwd; // allowSkills=true for listing

        const entries: string[] = [];

        async function listDir(dir: string, prefix = "") {
          const items = await fs.readdir(dir, { withFileTypes: true });
          for (const item of items) {
            const relativePath = prefix ? `${prefix}/${item.name}` : item.name;
            if (item.isDirectory()) {
              entries.push(`${relativePath}/`);
              if (params.recursive) {
                await listDir(path.join(dir, item.name), relativePath);
              }
            } else {
              entries.push(relativePath);
            }
          }
        }

        await listDir(dirPath);

        return {
          content: [{ type: "text", text: entries.length > 0 ? entries.join("\n") : "(empty directory)" }],
          details: undefined,
        };
      } catch (err) {
        return {
          content: [{ type: "text", text: `Error listing directory: ${err}` }],
          details: undefined,
        };
      }
    },
  };
}

// ============================================================================
// Bash Tool
// ============================================================================

const bashSchema = Type.Object({
  command: Type.String({ description: "The bash command to execute" }),
  cwd: Type.Optional(Type.String({ description: "Working directory (default: scratchpad)" })),
  timeout: Type.Optional(Type.Number({ description: "Timeout in milliseconds (default: 30000)" })),
});

/**
 * Build bwrap command for sandboxed execution.
 * Mounts system libs + scratchpad + network. No access to /home outside scratchpad.
 */
function buildBwrapCommand(command: string, cwd: string): string {
  // Build bwrap args - sandbox with network access, only scratchpad writable
  const args = [
    "bwrap",
    // Read-only system mounts (needed for basic commands)
    "--ro-bind", "/usr", "/usr",
    "--ro-bind", "/bin", "/bin",
    "--ro-bind", "/lib", "/lib",
    "--ro-bind", "/lib64", "/lib64",
    // Network support (DNS, hostnames, SSL certs)
    "--ro-bind", "/etc/resolv.conf", "/etc/resolv.conf",
    "--ro-bind", "/etc/hosts", "/etc/hosts",
    "--ro-bind", "/etc/ssl", "/etc/ssl",
    "--share-net",
    // Read-write scratchpad only
    "--bind", cwd, cwd,
    // Temp directory
    "--tmpfs", "/tmp",
    // Proc for some tools
    "--proc", "/proc",
    "--dev", "/dev",
    // Set working directory
    "--chdir", cwd,
    // Terminate with parent
    "--die-with-parent",
  ];

  // Add command at the end
  args.push("/bin/bash", "-c", command);

  // Escape args for shell
  return args.map(arg => `'${arg.replace(/'/g, "'\\''")}'`).join(" ");
}

/**
 * Check if a command involves skill execution.
 * Skills get full filesystem access to run their tools.
 */
function isSkillCommand(command: string): boolean {
  const skillPatterns = [
    /\/skills\//,                          // explicit skill path
    /skills\/[a-z0-9_-]+\//i,              // skill subdirectory
    /pptx|xlsx|pdf|d3js|auto-animate|image-gen/i,  // known skill names
    /node\s+\S*\.js/,                      // running node scripts (likely skill)
    /python\s+\S*\.py/,                    // running python scripts (likely skill)
    /npm\s+install/i,                      // npm install for skills
    /pip\s+install/i,                      // pip install for skills
    /npx\s+/,                              // npx commands
    /html2pptx|pptxgenjs|markitdown/i,     // known skill tools
    /tts\.sh|supertonic/i,                 // TTS voice generation
    /whisper|transcribe/i,                 // STT transcription
  ];
  return skillPatterns.some(pattern => pattern.test(command));
}

function createBashTool(ctx: SessionContext): AgentTool<typeof bashSchema, undefined> {
  const sandboxPath = createSandboxPath(ctx);
  return {
    name: "bash",
    label: "Execute Bash",
    description: "Execute a bash command in your scratchpad directory. Commands run in a sandbox with network access but limited to scratchpad for file operations.",
    parameters: bashSchema,
    execute: async (_toolCallId, params, signal): Promise<AgentToolResult<undefined>> => {
      const startTime = Date.now();
      try {
        const cwd = params.cwd ? sandboxPath(params.cwd) : ctx.sessionCwd;
        const timeout = params.timeout ?? 30000;

        // Skills get full access, other commands run in sandbox
        const useSkillMode = isSkillCommand(params.command);
        const finalCommand = useSkillMode
          ? params.command
          : buildBwrapCommand(params.command, cwd);

        console.log(`[bash] Executing ${useSkillMode ? '(skill mode)' : 'in sandbox'}: ${params.command.slice(0, 100)}${params.command.length > 100 ? '...' : ''}`);

        // Execute command
        const result = execSync(finalCommand, {
          cwd,
          timeout,
          encoding: "utf8",
          maxBuffer: 1024 * 1024 * 10, // 10MB
          shell: "/bin/bash",
        });

        const duration = Date.now() - startTime;
        console.log(`[bash] Success (${duration}ms): ${result.slice(0, 100).replace(/\n/g, ' ')}${result.length > 100 ? '...' : ''}`);

        return {
          content: [{ type: "text", text: result || "(no output)" }],
          details: undefined,
        };
      } catch (err: any) {
        // execSync throws on non-zero exit
        const output = err.stdout || err.stderr || err.message || String(err);
        const duration = Date.now() - startTime;
        console.log(`[bash] Failed (${duration}ms): ${output.slice(0, 100).replace(/\n/g, ' ')}${output.length > 100 ? '...' : ''}`);
        return {
          content: [{ type: "text", text: `Command failed:\n${output}` }],
          details: undefined,
        };
      }
    },
  };
}

// ============================================================================
// Search/Grep Tool
// ============================================================================

const searchSchema = Type.Object({
  pattern: Type.String({ description: "Regex pattern to search for" }),
  path: Type.Optional(Type.String({ description: "File or directory to search in (default: scratchpad)" })),
  filePattern: Type.Optional(Type.String({ description: "Glob pattern to filter files (e.g., '*.ts')" })),
  maxResults: Type.Optional(Type.Number({ description: "Maximum number of results (default: 50)" })),
});

function createSearchTool(ctx: SessionContext): AgentTool<typeof searchSchema, undefined> {
  const sandboxPath = createSandboxPath(ctx);
  return {
    name: "search",
    label: "Search Files",
    description: "Search for a pattern in files within your scratchpad using grep.",
    parameters: searchSchema,
    execute: async (_toolCallId, params): Promise<AgentToolResult<undefined>> => {
      try {
        const searchPath = params.path ? sandboxPath(params.path) : ctx.sessionCwd;
        const maxResults = params.maxResults ?? 50;

        // Build grep command
        let cmd = `grep -rn --color=never`;
        if (params.filePattern) {
          cmd += ` --include="${params.filePattern}"`;
        }
        cmd += ` -E "${params.pattern.replace(/"/g, '\\"')}" "${searchPath}" | head -${maxResults}`;

        const result = execSync(cmd, {
          encoding: "utf8",
          maxBuffer: 1024 * 1024,
          shell: "/bin/bash",
          timeout: 30000,
        });

        return {
          content: [{ type: "text", text: result || "No matches found" }],
          details: undefined,
        };
      } catch (err: any) {
        // grep returns exit code 1 when no matches found
        if (err.status === 1 && !err.stderr) {
          return {
            content: [{ type: "text", text: "No matches found" }],
            details: undefined,
          };
        }
        return {
          content: [{ type: "text", text: `Search error: ${err.message || err}` }],
          details: undefined,
        };
      }
    },
  };
}

// ============================================================================
// Web Search Tool (using Brave Search)
// ============================================================================

const webSearchSchema = Type.Object({
  query: Type.String({ description: "Search query" }),
  maxResults: Type.Optional(Type.Number({ description: "Maximum number of results (default: 5)" })),
  content: Type.Optional(Type.Boolean({ description: "Fetch page content as markdown (default: false)" })),
});

interface BraveSearchResult {
  title: string;
  link: string;
  snippet: string;
  content?: string;
}

async function fetchBraveResults(query: string, numResults: number): Promise<BraveSearchResult[]> {
  const url = `https://search.brave.com/search?q=${encodeURIComponent(query)}`;

  const response = await fetch(url, {
    headers: {
      "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
      "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
      "Accept-Language": "en-US,en;q=0.9",
    },
    signal: AbortSignal.timeout(15000),
  });

  if (!response.ok) {
    throw new Error(`HTTP ${response.status}: ${response.statusText}`);
  }

  const html = await response.text();

  // Parse results using regex (avoiding jsdom dependency)
  const results: BraveSearchResult[] = [];

  // Match snippet divs with data-type="web"
  const snippetRegex = /<div[^>]*class="snippet[^"]*"[^>]*data-type="web"[^>]*>([\s\S]*?)<\/div>\s*<\/div>\s*<\/div>/g;
  let snippetMatch;

  while ((snippetMatch = snippetRegex.exec(html)) !== null && results.length < numResults) {
    const snippetHtml = snippetMatch[1];

    // Extract link and title
    const linkMatch = snippetHtml.match(/<a[^>]*class="[^"]*svelte-[^"]*"[^>]*href="([^"]*)"[^>]*>([\s\S]*?)<\/a>/);
    if (!linkMatch) continue;

    const link = linkMatch[1];
    if (!link || link.includes("brave.com")) continue;

    // Extract title text from inside the link
    const titleMatch = linkMatch[2].match(/<span[^>]*class="title[^"]*"[^>]*>([^<]*)<\/span>/);
    const title = titleMatch ? titleMatch[1].trim() : linkMatch[2].replace(/<[^>]+>/g, "").trim();

    // Extract snippet/description
    const descMatch = snippetHtml.match(/<p[^>]*class="snippet-description[^"]*"[^>]*>([\s\S]*?)<\/p>/);
    let snippet = descMatch ? descMatch[1].replace(/<[^>]+>/g, "").trim() : "";
    // Remove date prefix like "Jan 1, 2024 - "
    snippet = snippet.replace(/^[A-Z][a-z]+ \d+, \d{4} -\s*/, "");

    if (title && link) {
      results.push({ title, link, snippet });
    }
  }

  // Fallback: try alternative selector pattern if no results
  if (results.length === 0) {
    const altRegex = /<a[^>]*href="(https?:\/\/(?!brave\.com)[^"]+)"[^>]*>[\s\S]*?<span[^>]*class="title[^"]*"[^>]*>([^<]+)<\/span>/g;
    let altMatch;
    while ((altMatch = altRegex.exec(html)) !== null && results.length < numResults) {
      results.push({
        title: altMatch[2].trim(),
        link: altMatch[1],
        snippet: "",
      });
    }
  }

  return results;
}

async function fetchPageContent(url: string): Promise<string> {
  try {
    const response = await fetch(url, {
      headers: {
        "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36",
        "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
      },
      signal: AbortSignal.timeout(10000),
    });

    if (!response.ok) {
      return `(HTTP ${response.status})`;
    }

    let html = await response.text();

    // Simple HTML to text/markdown conversion
    // Remove script and style
    html = html.replace(/<script[^>]*>[\s\S]*?<\/script>/gi, "");
    html = html.replace(/<style[^>]*>[\s\S]*?<\/style>/gi, "");
    html = html.replace(/<noscript[^>]*>[\s\S]*?<\/noscript>/gi, "");
    html = html.replace(/<nav[^>]*>[\s\S]*?<\/nav>/gi, "");
    html = html.replace(/<header[^>]*>[\s\S]*?<\/header>/gi, "");
    html = html.replace(/<footer[^>]*>[\s\S]*?<\/footer>/gi, "");
    html = html.replace(/<aside[^>]*>[\s\S]*?<\/aside>/gi, "");

    // Try to extract main content
    const mainMatch = html.match(/<main[^>]*>([\s\S]*?)<\/main>/i) ||
                      html.match(/<article[^>]*>([\s\S]*?)<\/article>/i) ||
                      html.match(/<div[^>]*role="main"[^>]*>([\s\S]*?)<\/div>/i);

    const content = mainMatch ? mainMatch[1] : html;

    // Convert to text
    let text = content
      .replace(/<h[1-6][^>]*>([^<]*)<\/h[1-6]>/gi, "\n\n## $1\n\n")
      .replace(/<p[^>]*>/gi, "\n\n")
      .replace(/<\/p>/gi, "")
      .replace(/<br\s*\/?>/gi, "\n")
      .replace(/<li[^>]*>/gi, "\n- ")
      .replace(/<[^>]+>/g, " ")
      .replace(/&nbsp;/g, " ")
      .replace(/&amp;/g, "&")
      .replace(/&lt;/g, "<")
      .replace(/&gt;/g, ">")
      .replace(/&quot;/g, '"')
      .replace(/&#39;/g, "'")
      .replace(/ +/g, " ")
      .replace(/\n{3,}/g, "\n\n")
      .trim();

    if (text.length > 5000) {
      text = text.substring(0, 5000) + "...";
    }

    return text.length > 100 ? text : "(Could not extract content)";
  } catch (e: any) {
    return `(Error: ${e.message})`;
  }
}

export const webSearchTool: AgentTool<typeof webSearchSchema, undefined> = {
  name: "web_search",
  label: "Web Search",
  description: "Search the web using Brave Search. Returns titles, URLs, and snippets. Optionally fetch page content.",
  parameters: webSearchSchema,
  execute: async (_toolCallId, params): Promise<AgentToolResult<undefined>> => {
    try {
      const maxResults = params.maxResults ?? 5;
      const fetchContent = params.content ?? false;

      console.log(`[web_search] Searching Brave for: ${params.query}`);
      const results = await fetchBraveResults(params.query, maxResults);

      if (results.length === 0) {
        return {
          content: [{ type: "text", text: "No search results found" }],
          details: undefined,
        };
      }

      // Optionally fetch content for each result
      if (fetchContent) {
        for (const result of results) {
          result.content = await fetchPageContent(result.link);
        }
      }

      // Format output
      const output = results.map((r, i) => {
        let text = `--- Result ${i + 1} ---\nTitle: ${r.title}\nLink: ${r.link}`;
        if (r.snippet) text += `\nSnippet: ${r.snippet}`;
        if (r.content) text += `\nContent:\n${r.content}`;
        return text;
      }).join("\n\n");

      return {
        content: [{ type: "text", text: output }],
        details: undefined,
      };
    } catch (err) {
      return {
        content: [{ type: "text", text: `Web search error: ${err}` }],
        details: undefined,
      };
    }
  },
};

// ============================================================================
// Web Fetch Tool
// ============================================================================

const webFetchSchema = Type.Object({
  url: Type.String({ description: "URL to fetch" }),
  maxLength: Type.Optional(Type.Number({ description: "Maximum response length in chars (default: 10000)" })),
});

export const webFetchTool: AgentTool<typeof webFetchSchema, undefined> = {
  name: "web_fetch",
  label: "Fetch URL",
  description: "Fetch content from a URL. Returns the text content (HTML tags stripped for HTML pages).",
  parameters: webFetchSchema,
  execute: async (_toolCallId, params): Promise<AgentToolResult<undefined>> => {
    try {
      const maxLength = params.maxLength ?? 10000;

      const response = await fetch(params.url, {
        headers: {
          "User-Agent": "Mozilla/5.0 (compatible; Pi-Agent/1.0)",
        },
      });

      if (!response.ok) {
        return {
          content: [{ type: "text", text: `HTTP error: ${response.status} ${response.statusText}` }],
          details: undefined,
        };
      }

      let text = await response.text();

      // Strip HTML tags if it looks like HTML
      if (text.includes("<html") || text.includes("<!DOCTYPE")) {
        // Simple HTML to text conversion
        text = text
          .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, "")
          .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, "")
          .replace(/<[^>]+>/g, " ")
          .replace(/&nbsp;/g, " ")
          .replace(/&amp;/g, "&")
          .replace(/&lt;/g, "<")
          .replace(/&gt;/g, ">")
          .replace(/&quot;/g, '"')
          .replace(/\s+/g, " ")
          .trim();
      }

      if (text.length > maxLength) {
        text = text.slice(0, maxLength) + `\n\n... [truncated, ${text.length} chars total]`;
      }

      return {
        content: [{ type: "text", text }],
        details: undefined,
      };
    } catch (err) {
      return {
        content: [{ type: "text", text: `Fetch error: ${err}` }],
        details: undefined,
      };
    }
  },
};

// ============================================================================
// Get Current Time Tool
// ============================================================================

const getCurrentTimeSchema = Type.Object({
  timezone: Type.Optional(Type.String({ description: "Timezone (default: local)" })),
});

export const getCurrentTimeTool: AgentTool<typeof getCurrentTimeSchema, undefined> = {
  name: "get_current_time",
  label: "Get Time",
  description: "Get the current date and time",
  parameters: getCurrentTimeSchema,
  execute: async (_toolCallId, params): Promise<AgentToolResult<undefined>> => {
    const now = new Date();
    const options: Intl.DateTimeFormatOptions = {
      weekday: "long",
      year: "numeric",
      month: "long",
      day: "numeric",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      timeZoneName: "short",
    };

    if (params.timezone) {
      options.timeZone = params.timezone;
    }

    return {
      content: [{ type: "text", text: now.toLocaleString("en-US", options) }],
      details: undefined,
    };
  },
};

// ============================================================================
// Attach File Tool (upload files to Slack)
// ============================================================================

const attachSchema = Type.Object({
  path: Type.String({ description: "Path to the file to upload (absolute or relative to scratchpad)" }),
  title: Type.Optional(Type.String({ description: "Optional title/filename for the uploaded file" })),
});

// Upload functions set per-request by the Slack handler, keyed by session name.
// Keying by session (instead of a single global) prevents concurrent handlers
// for different channels/DMs from stomping each other's closures.
const uploadFunctions = new Map<string, (filePath: string, title?: string) => Promise<void>>();

/**
 * Set the upload function for the attach tool for a given session.
 * Must be called before each agent request with the context's uploadFile function,
 * and cleared (passing null) on cleanup so a stale closure can't leak.
 */
export function setUploadFunction(sessionName: string, fn: ((filePath: string, title?: string) => Promise<void>) | null): void {
  if (fn) uploadFunctions.set(sessionName, fn);
  else uploadFunctions.delete(sessionName);
}

// Block Kit renderers set per-request by the Slack handler, keyed by session
// name (mirrors uploadFunctions).
const blockRenderers = new Map<string, (blocks: unknown[], text: string) => Promise<void>>();

/**
 * Set the Block Kit renderer for the render_ui tool for a given session.
 * Must be called before each agent request with the context's respondBlocks function,
 * and cleared (passing null) on cleanup so a stale closure can't leak across sessions.
 */
export function setBlockRenderer(sessionName: string, fn: ((blocks: unknown[], text: string) => Promise<void>) | null): void {
  if (fn) blockRenderers.set(sessionName, fn);
  else blockRenderers.delete(sessionName);
}

function createAttachTool(ctx: SessionContext): AgentTool<typeof attachSchema, undefined> {
  const sandboxPath = createSandboxPath(ctx);
  return {
    name: "attach",
    label: "Upload File",
    description: "Upload a file to the current Slack channel. Use this to share images, documents, or any files with the user.",
    parameters: attachSchema,
    execute: async (_toolCallId, params, signal): Promise<AgentToolResult<undefined>> => {
      const uploadFunction = uploadFunctions.get(ctx.sessionName);
      if (!uploadFunction) {
        return {
          content: [{ type: "text", text: "Error: File upload not available in this context" }],
          details: undefined,
        };
      }

      try {
        const filePath = sandboxPath(params.path, true); // allowSkills=true for reading files to upload

        // Check file exists
        try {
          await fs.access(filePath);
        } catch {
          return {
            content: [{ type: "text", text: `Error: File not found: ${filePath}` }],
            details: undefined,
          };
        }

        const fileName = params.title || path.basename(filePath);
        await uploadFunction(filePath, fileName);

        return {
          content: [{ type: "text", text: `Successfully uploaded: ${fileName}` }],
          details: undefined,
        };
      } catch (err) {
        return {
          content: [{ type: "text", text: `Error uploading file: ${err}` }],
          details: undefined,
        };
      }
    },
  };
}

// ============================================================================
// Render UI Tool (Block Kit generative UI)
// ============================================================================

const renderUiSchema = Type.Object({
  title: Type.Optional(Type.String({ description: "Card title, rendered as a header" })),
  context: Type.Optional(Type.Array(Type.String(), { description: "Small gray metadata line under the title (status, dates, owners; max 10 items)" })),
  paragraphs: Type.Optional(Type.Array(Type.String(), { description: "Markdown paragraphs" })),
  cards: Type.Optional(
    Type.Array(
      Type.Object({
        title: Type.String({ description: "Card title (linked when url is set)" }),
        url: Type.Optional(Type.String({ description: "Link target; also renders an Open button" })),
        status: Type.Optional(Type.String({ description: "Status shown in the card's context line, e.g. `🟢 In Progress`" })),
        badges: Type.Optional(Type.Array(Type.String(), { description: "Extra context-line badges, e.g. assignee, priority" })),
        body: Type.Optional(Type.String({ description: "Markdown body under the title" })),
        fields: Type.Optional(Type.Array(Type.Object({ label: Type.String(), value: Type.String() }))),
      }),
      { description: "Rich item cards (issues, pages, incidents) rendered with title, status line, body, and an Open link" }
    )
  ),
  table: Type.Optional(
    Type.Object(
      {
        headers: Type.Array(Type.String()),
        rows: Type.Array(Type.Array(Type.Union([Type.String(), Type.Number()]))),
      },
      { description: "A monospaced table with headers and rows" }
    )
  ),
  fields: Type.Optional(
    Type.Array(
      Type.Object({ label: Type.String(), value: Type.String() }),
      { description: "Key/value fields (max 10 shown)" }
    )
  ),
  bars: Type.Optional(
    Type.Array(
      Type.Object({ label: Type.String(), value: Type.Number() }),
      { description: "Unicode bar-chart entries; bars are scaled to the largest value" }
    )
  ),
  buttons: Type.Optional(
    Type.Array(
      Type.Object({
        text: Type.String(),
        actionId: Type.String(),
        url: Type.Optional(Type.String({ description: "If set, the button opens this URL instead of firing an action" })),
        style: Type.Optional(Type.Union([Type.Literal("primary"), Type.Literal("danger")])),
      }),
      { description: "Buttons rendered in an actions block (max 25 shown)" }
    )
  ),
});

function createRenderUiTool(ctx: SessionContext): AgentTool<typeof renderUiSchema, undefined> {
  return {
    name: "render_ui",
    label: "Render UI",
    description:
      "Render structured UI (item cards with status/links, table, key/value fields, unicode bar chart, context line, and/or buttons) inline in Slack via Block Kit. Use `cards` for lists of issues, pages, or incidents. Call this as your FINAL action for a turn because it replaces the current message. Do not also print the same data as plain text.",
    parameters: renderUiSchema,
    execute: async (_toolCallId, params: Static<typeof renderUiSchema>): Promise<AgentToolResult<undefined>> => {
      const blockRenderer = blockRenderers.get(ctx.sessionName);
      if (!blockRenderer) {
        return {
          content: [{ type: "text", text: "UI rendering is not available in this context." }],
          details: undefined,
        };
      }
      try {
        const ui = params as UiSpec;
        await blockRenderer(dslToBlocks(ui), ui.title ?? "Update");
        return {
          content: [{ type: "text", text: "Rendered UI to Slack." }],
          details: undefined,
        };
      } catch (err: any) {
        return {
          content: [{ type: "text", text: `Error rendering UI: ${err.message || String(err)}` }],
          details: undefined,
        };
      }
    },
  };
}

// ============================================================================
// Render Chart Tool (SVG → PNG via sharp, uploaded to Slack)
// ============================================================================

const chartSeriesSchema = Type.Object({
  name: Type.String({ description: "Series name (shown in the legend)" }),
  values: Type.Array(Type.Number(), { description: "One value per label, in label order" }),
});

const renderChartSchema = Type.Object({
  type: Type.Union([Type.Literal("bar"), Type.Literal("line"), Type.Literal("pie")], {
    description: "bar = magnitude comparison, line = change over time, pie = parts of a whole (single series)",
  }),
  title: Type.Optional(Type.String({ description: "Chart title" })),
  labels: Type.Array(Type.String(), { description: "Category / x-axis labels (pie: slice labels)" }),
  series: Type.Array(chartSeriesSchema, { description: "Data series (max 8; pie uses only the first)" }),
  filename: Type.Optional(Type.String({ description: "Output filename (default: auto-generated)" })),
});

function createRenderChartTool(ctx: SessionContext): AgentTool<typeof renderChartSchema, undefined> {
  return {
    name: "render_chart",
    label: "Render Chart",
    description:
      "Render a real chart (bar, line, or pie) as a PNG image and upload it to the current Slack channel. Prefer this over render_ui's unicode bars for anything beyond a quick comparison.",
    parameters: renderChartSchema,
    execute: async (_toolCallId, params: Static<typeof renderChartSchema>): Promise<AgentToolResult<undefined>> => {
      try {
        const { chartToSvg, MAX_SERIES } = await import("../media/svg-chart.js");
        const sharp = (await import("sharp")).default;

        const svg = chartToSvg({
          type: params.type,
          title: params.title,
          labels: params.labels,
          series: params.series,
        });

        const outputDir = path.join(ctx.sessionCwd, "charts");
        await fs.mkdir(outputDir, { recursive: true });
        const safeTitle = (params.title ?? params.type).slice(0, 40).replace(/[^a-zA-Z0-9]/g, "_").toLowerCase();
        const filename = params.filename || `${safeTitle}_${Date.now()}.png`;
        const outputPath = path.join(outputDir, filename.endsWith(".png") ? filename : `${filename}.png`);

        // Rasterize at 2x for crisp text in Slack previews.
        const png = await sharp(Buffer.from(svg), { density: 144 }).png().toBuffer();
        await fs.writeFile(outputPath, png);

        const uploadFunction = uploadFunctions.get(ctx.sessionName);
        let note = "";
        if (uploadFunction) {
          await uploadFunction(outputPath, params.title ? `${params.title}.png` : undefined);
        } else {
          note = "\n(No upload available in this context — use MEDIA: token or attach to send it.)";
        }
        const dropped = params.series.length > MAX_SERIES ? `\nNote: only the first ${MAX_SERIES} series were plotted.` : "";
        return {
          content: [{ type: "text", text: `Chart rendered${uploadFunction ? " and uploaded" : ""}.\nPath: ${outputPath}${dropped}${note}` }],
          details: undefined,
        };
      } catch (err: any) {
        return {
          content: [{ type: "text", text: `Error rendering chart: ${err.message || String(err)}` }],
          details: undefined,
        };
      }
    },
  };
}

// ============================================================================
// Render Diagram Tool (mermaid/graphviz/plantuml via Kroki → PNG upload)
// ============================================================================

const renderDiagramSchema = Type.Object({
  format: Type.Union([Type.Literal("mermaid"), Type.Literal("graphviz"), Type.Literal("plantuml")], {
    description: "Diagram language of `source`",
  }),
  source: Type.String({ description: "Diagram source, e.g. mermaid 'flowchart TD; A-->B'" }),
  filename: Type.Optional(Type.String({ description: "Output filename (default: auto-generated)" })),
});

function createRenderDiagramTool(ctx: SessionContext): AgentTool<typeof renderDiagramSchema, undefined> {
  return {
    name: "render_diagram",
    label: "Render Diagram",
    description:
      "Render a diagram (mermaid flowchart/sequence/gantt, graphviz dot, or plantuml) to a PNG image and upload it to the current Slack channel. Rendered via hosted APIs (mermaid.ink / kroki.io), so it needs network access.",
    parameters: renderDiagramSchema,
    execute: async (_toolCallId, params: Static<typeof renderDiagramSchema>): Promise<AgentToolResult<undefined>> => {
      try {
        // kroki.io's mermaid companion service is unreliable; mermaid.ink is the
        // dedicated mermaid renderer, so route mermaid there and the rest to kroki.
        let response: Response;
        if (params.format === "mermaid") {
          const encoded = Buffer.from(JSON.stringify({ code: params.source, mermaid: { theme: "default" } })).toString("base64url");
          response = await fetch(`https://mermaid.ink/img/${encoded}?type=png`, {
            signal: AbortSignal.timeout(30000),
          });
        } else {
          const krokiBase = process.env.KROKI_URL || "https://kroki.io";
          response = await fetch(`${krokiBase}/${params.format}/png`, {
            method: "POST",
            headers: { "Content-Type": "text/plain" },
            body: params.source,
            signal: AbortSignal.timeout(30000),
          });
        }
        if (!response.ok) {
          const detail = (await response.text()).slice(0, 500);
          return {
            content: [{ type: "text", text: `Diagram rendering failed (HTTP ${response.status}): ${detail}` }],
            details: undefined,
          };
        }
        const png = Buffer.from(await response.arrayBuffer());

        const outputDir = path.join(ctx.sessionCwd, "diagrams");
        await fs.mkdir(outputDir, { recursive: true });
        const filename = params.filename || `${params.format}_${Date.now()}.png`;
        const outputPath = path.join(outputDir, filename.endsWith(".png") ? filename : `${filename}.png`);
        await fs.writeFile(outputPath, png);

        const uploadFunction = uploadFunctions.get(ctx.sessionName);
        if (uploadFunction) {
          await uploadFunction(outputPath);
          return { content: [{ type: "text", text: `Diagram rendered and uploaded.\nPath: ${outputPath}` }], details: undefined };
        }
        return {
          content: [{ type: "text", text: `Diagram rendered.\nPath: ${outputPath}\nUse MEDIA:${outputPath} to send it.` }],
          details: undefined,
        };
      } catch (err: any) {
        const msg = err.name === "TimeoutError" ? "Diagram rendering timed out (30s)." : `Error rendering diagram: ${err.message || String(err)}`;
        return { content: [{ type: "text", text: msg }], details: undefined };
      }
    },
  };
}

// ============================================================================
// Generate Image Tool (Text-to-Image via Gemini)
// ============================================================================

const generateImageSchema = Type.Object({
  prompt: Type.String({ description: "Description of the image to generate" }),
  filename: Type.Optional(Type.String({ description: "Output filename (default: auto-generated)" })),
});

function createGenerateImageTool(ctx: SessionContext): AgentTool<typeof generateImageSchema, undefined> {
  return {
    name: "generate_image",
    label: "Generate Image",
    description: "Generate an image from a text description using Gemini. Returns the file path - use with MEDIA: token to send. Takes 15-30 seconds.",
    parameters: generateImageSchema,
    execute: async (_toolCallId, params): Promise<AgentToolResult<undefined>> => {
      try {
        const apiKey = process.env.GEMINI_API_KEY;
        if (!apiKey) {
          return {
            content: [{ type: "text", text: "Error: GEMINI_API_KEY environment variable not set" }],
            details: undefined,
          };
        }

        const outputDir = path.join(ctx.sessionCwd, "generated-images");
        await fs.mkdir(outputDir, { recursive: true });

        const timestamp = Date.now();
        const safePrompt = params.prompt.slice(0, 50).replace(/[^a-zA-Z0-9]/g, "_").toLowerCase();
        const filename = params.filename || `${safePrompt}_${timestamp}.png`;
        const outputPath = path.join(outputDir, filename);

        const requestBody = {
          contents: [{
            parts: [{ text: params.prompt }]
          }],
          generationConfig: {
            responseModalities: ["TEXT", "IMAGE"]
          }
        };
        console.log(`[generate_image] Calling Gemini API with prompt: ${params.prompt.slice(0, 50)}...`);

        const response = await fetch(
          "https://generativelanguage.googleapis.com/v1beta/models/gemini-3-pro-image-preview:generateContent",
          {
            method: "POST",
            headers: {
              "x-goog-api-key": apiKey,
              "Content-Type": "application/json",
            },
            body: JSON.stringify(requestBody),
            signal: AbortSignal.timeout(60000), // 60 second timeout
          }
        );

        console.log(`[generate_image] Response status: ${response.status}`);
        if (!response.ok) {
          const errorText = await response.text();
          console.log(`[generate_image] API error: ${errorText.slice(0, 500)}`);
          return {
            content: [{ type: "text", text: `API error ${response.status}: ${errorText}` }],
            details: undefined,
          };
        }

        const data = await response.json() as any;
        console.log(`[generate_image] Got response, candidates: ${data?.candidates?.length || 0}`);

        // Extract base64 image data from response
        const parts = data?.candidates?.[0]?.content?.parts;
        if (!parts || parts.length === 0) {
          console.log(`[generate_image] No parts in response`);
          return {
            content: [{ type: "text", text: "No image generated in response" }],
            details: undefined,
          };
        }

        const imagePart = parts.find((p: any) => p.inlineData?.data);
        if (!imagePart) {
          const textPart = parts.find((p: any) => p.text);
          console.log(`[generate_image] No image part, text: ${textPart?.text?.slice(0, 100)}`);
          return {
            content: [{ type: "text", text: textPart?.text || "No image data in response" }],
            details: undefined,
          };
        }

        const base64Data = imagePart.inlineData.data;
        const imageBuffer = Buffer.from(base64Data, "base64");
        await fs.writeFile(outputPath, imageBuffer);
        console.log(`[generate_image] Image saved to: ${outputPath} (${imageBuffer.length} bytes)`);

        return {
          content: [{ type: "text", text: `Image generated successfully!\nPath: ${outputPath}\n\nUse MEDIA:${outputPath} to send this image.` }],
          details: undefined,
        };
      } catch (err: any) {
        console.log(`[generate_image] Error: ${err.message || err}`);
        if (err.name === "TimeoutError") {
          return {
            content: [{ type: "text", text: "Image generation timed out (60s limit). Try a simpler prompt." }],
            details: undefined,
          };
        }
        return {
          content: [{ type: "text", text: `Error generating image: ${err.message || err}` }],
          details: undefined,
        };
      }
    },
  };
}

// ============================================================================
// Edit Image Tool (Image + Text to Image via Gemini)
// ============================================================================

const editImageSchema = Type.Object({
  imagePath: Type.String({ description: "Path to the source image to edit" }),
  prompt: Type.String({ description: "Description of edits to make to the image" }),
  filename: Type.Optional(Type.String({ description: "Output filename (default: auto-generated)" })),
});

function createEditImageTool(ctx: SessionContext): AgentTool<typeof editImageSchema, undefined> {
  const sandboxPath = createSandboxPath(ctx);
  return {
    name: "edit_image",
    label: "Edit Image",
    description: "Edit an existing image based on a text prompt using Gemini. Returns the file path - use with MEDIA: token to send. Takes 15-30 seconds.",
    parameters: editImageSchema,
    execute: async (_toolCallId, params): Promise<AgentToolResult<undefined>> => {
      try {
        const apiKey = process.env.GEMINI_API_KEY;
        if (!apiKey) {
          return {
            content: [{ type: "text", text: "Error: GEMINI_API_KEY environment variable not set" }],
            details: undefined,
          };
        }

        // Read source image (sandboxed)
        const imagePath = sandboxPath(params.imagePath, true);
        let imageBuffer: Buffer;
        try {
          imageBuffer = await fs.readFile(imagePath);
        } catch {
          return {
            content: [{ type: "text", text: `Error: Could not read source image at ${imagePath}` }],
            details: undefined,
          };
        }

        const base64Image = imageBuffer.toString("base64");

        // Detect mime type from extension
        const ext = path.extname(imagePath).toLowerCase();
        const mimeType = ext === ".png" ? "image/png"
          : ext === ".webp" ? "image/webp"
          : ext === ".gif" ? "image/gif"
          : "image/jpeg";

        const outputDir = path.join(ctx.sessionCwd, "generated-images");
        await fs.mkdir(outputDir, { recursive: true });

        const timestamp = Date.now();
        const safePrompt = params.prompt.slice(0, 30).replace(/[^a-zA-Z0-9]/g, "_").toLowerCase();
        const filename = params.filename || `edited_${safePrompt}_${timestamp}.png`;
        const outputPath = path.join(outputDir, filename);

        const requestBody = {
          contents: [{
            parts: [
              { text: params.prompt },
              {
                inlineData: {
                  mimeType,
                  data: base64Image,
                }
              }
            ]
          }],
          generationConfig: {
            responseModalities: ["TEXT", "IMAGE"]
          }
        };
        console.log(`[edit_image] Calling Gemini API with prompt: ${params.prompt.slice(0, 50)}...`);

        const response = await fetch(
          "https://generativelanguage.googleapis.com/v1beta/models/gemini-3-pro-image-preview:generateContent",
          {
            method: "POST",
            headers: {
              "x-goog-api-key": apiKey,
              "Content-Type": "application/json",
            },
            body: JSON.stringify(requestBody),
            signal: AbortSignal.timeout(60000), // 60 second timeout
          }
        );

        if (!response.ok) {
          const errorText = await response.text();
          return {
            content: [{ type: "text", text: `API error ${response.status}: ${errorText}` }],
            details: undefined,
          };
        }

        const data = await response.json() as any;

        // Extract base64 image data from response
        const parts = data?.candidates?.[0]?.content?.parts;
        if (!parts || parts.length === 0) {
          return {
            content: [{ type: "text", text: "No image generated in response" }],
            details: undefined,
          };
        }

        const imagePart = parts.find((p: any) => p.inlineData?.data);
        if (!imagePart) {
          const textPart = parts.find((p: any) => p.text);
          return {
            content: [{ type: "text", text: textPart?.text || "No image data in response" }],
            details: undefined,
          };
        }

        const resultBase64 = imagePart.inlineData.data;
        const resultBuffer = Buffer.from(resultBase64, "base64");
        await fs.writeFile(outputPath, resultBuffer);

        return {
          content: [{ type: "text", text: `Image edited successfully!\nPath: ${outputPath}\n\nUse MEDIA:${outputPath} to send this image.` }],
          details: undefined,
        };
      } catch (err: any) {
        if (err.name === "TimeoutError") {
          return {
            content: [{ type: "text", text: "Image editing timed out (60s limit). Try a simpler prompt." }],
            details: undefined,
          };
        }
        return {
          content: [{ type: "text", text: `Error editing image: ${err.message || err}` }],
          details: undefined,
        };
      }
    },
  };
}

// ============================================================================
// MCP Tool (via mcporter for SSE/streaming support)
// ============================================================================

const mcpSchema = Type.Object({
  action: Type.Union([
    Type.Literal("list-servers"),
    Type.Literal("list-tools"),
    Type.Literal("call"),
  ], { description: "Action: list-servers, list-tools, or call" }),
  server: Type.Optional(Type.String({ description: "Server name (required for list-tools and call)" })),
  tool: Type.Optional(Type.String({ description: "Tool name (required for call)" })),
  args: Type.Optional(Type.Record(Type.String(), Type.Any(), { description: "Tool arguments as key-value pairs" })),
});

// Lazy import mcporter - per-config runtimes (cached by config path)
const mcporterRuntimes: Map<string, any> = new Map();

/**
 * Get the mcporter config path for a session.
 * Checks session-specific first, then global Slack config, then app config.
 */
function getMcporterConfigPath(sessionName: string): string {
  // 1. Session-specific config: ~/relay01/slack/@user/mcporter.json
  const sessionConfig = path.join(SLACK_BASE_PATH, sessionName, "mcporter.json");
  if (fsSync.existsSync(sessionConfig)) {
    return sessionConfig;
  }

  // 2. Global Slack config: ~/relay01/slack/mcporter.json
  const globalSlackConfig = path.join(SLACK_BASE_PATH, "mcporter.json");
  if (fsSync.existsSync(globalSlackConfig)) {
    return globalSlackConfig;
  }

  // 3. App config (fallback): config/mcporter.json
  return path.join(process.cwd(), "config", "mcporter.json");
}

async function getMcporterRuntime(sessionName: string) {
  const configPath = getMcporterConfigPath(sessionName);
  const cacheKey = configPath; // Cache by config path, not session

  if (!mcporterRuntimes.has(cacheKey)) {
    try {
      const { createRuntime } = await import("mcporter");
      const runtime = await createRuntime({ configPath });
      mcporterRuntimes.set(cacheKey, runtime);
      console.log(`[mcp] mcporter runtime initialized for config: ${configPath}`);
    } catch (err: any) {
      throw new Error(`Failed to initialize mcporter (config: ${configPath}): ${err.message}`);
    }
  }
  return mcporterRuntimes.get(cacheKey);
}

function createMcpTool(ctx: SessionContext): AgentTool<typeof mcpSchema, undefined> {
  return {
    name: "mcp",
    label: "MCP Tools",
    description: "Access MCP servers (Twitter, Reddit, etc). Actions: list-servers, list-tools <server>, call <server> <tool> [args]. Example: call twitter TWITTER_RECENT_SEARCH {query: 'from:arcprize'}",
    parameters: mcpSchema,
    execute: async (_toolCallId, params): Promise<AgentToolResult<undefined>> => {
      try {
        const runtime = await getMcporterRuntime(ctx.sessionName);

        if (params.action === "list-servers") {
          console.log("[mcp] Listing servers");
          const servers = runtime.listServers();
          if (!servers || servers.length === 0) {
            return {
              content: [{ type: "text", text: "No MCP servers configured. Add servers to config/mcporter.json" }],
              details: undefined,
            };
          }
          return {
            content: [{ type: "text", text: `Available MCP servers:\n${servers.join("\n")}` }],
            details: undefined,
          };
        }

        if (params.action === "list-tools") {
          if (!params.server) {
            return {
              content: [{ type: "text", text: "Error: server parameter required for list-tools" }],
              details: undefined,
            };
          }
          console.log(`[mcp] Listing tools for server: ${params.server}`);
          const tools = await runtime.listTools(params.server);
          if (!tools || tools.length === 0) {
            return {
              content: [{ type: "text", text: `No tools found for server "${params.server}"` }],
              details: undefined,
            };
          }
          const toolList = tools.map((t: any) => {
            const desc = t.description ? `: ${t.description.slice(0, 80)}...` : "";
            return `- ${t.name}${desc}`;
          }).join("\n");
          return {
            content: [{ type: "text", text: `Tools for ${params.server} (${tools.length} total):\n${toolList}` }],
            details: undefined,
          };
        }

        if (params.action === "call") {
          if (!params.server || !params.tool) {
            return {
              content: [{ type: "text", text: "Error: server and tool parameters required for call" }],
              details: undefined,
            };
          }
          const toolArgs = params.args ?? {};
          console.log(`[mcp] Calling ${params.server}.${params.tool}`);
          console.log(`[mcp] Args:`, JSON.stringify(toolArgs));
          // mcporter expects { args: {...} } not just {...}
          const result = await runtime.callTool(params.server, params.tool, { args: toolArgs });

          // Extract text from result
          let text: string;
          if (typeof result.text === "function") {
            text = result.text();
          } else if (result.content) {
            text = result.content.map((c: any) => c.text || JSON.stringify(c)).join("\n");
          } else {
            text = JSON.stringify(result, null, 2);
          }

          return {
            content: [{ type: "text", text }],
            details: undefined,
          };
        }

        return {
          content: [{ type: "text", text: `Unknown action: ${params.action}` }],
          details: undefined,
        };
      } catch (err: any) {
        console.error(`[mcp] Error:`, err);
        const errorDetail = err.message || String(err);
        return {
          content: [{ type: "text", text: `MCP error: ${errorDetail}` }],
          details: undefined,
        };
      }
    },
  };
}

// ============================================================================
// Agent Run tools (delegate heavy work to a background pi --rlm run)
// ============================================================================

const agentRunSchema = Type.Object({
  task: Type.String({
    description: "The task for the background agent to perform",
  }),
  definitionId: Type.Optional(
    Type.String({
      description:
        "Agent definition id to use (see 'agent list'); omit for an ad-hoc run",
    }),
  ),
  timeout: Type.Optional(
    Type.String({
      description:
        'Maximum run duration, e.g. "45m", "2h", "90s". Defaults to the agent ' +
        "definition's timeout (30m for ad-hoc runs). Set a higher value for " +
        "tasks likely to exceed the default.",
    }),
  ),
});

function createAgentRunTool(ctx: SessionContext): AgentTool<typeof agentRunSchema, undefined> {
  return {
    name: "agent_run",
    label: "Run Background Agent",
    description:
      "The ONLY way to start a background task. Delegates a heavy or long-running " +
      "task to a background agent (pi in rlm mode) in a separate process and returns " +
      "a run id immediately; the result is announced in chat when the run completes. " +
      "Use for multi-step research, large file processing, or anything too slow for " +
      "the chat turn. Never claim a background task was started unless this tool " +
      "returned a run id — report that exact id to the user.",
    parameters: agentRunSchema,
    execute: async (_toolCallId, params): Promise<AgentToolResult<undefined>> => {
      try {
        // Lazy import to avoid circular deps at module load time
        const { getAgentManager } = await import("./agents/manager.js");
        const manager = getAgentManager();
        const run = await manager.startRun({
          definitionId: params.definitionId,
          userPrompt: params.task,
          session: ctx.sessionName,
          // Ad-hoc runs work in the session scratchpad, not the relay's cwd
          cwd: ctx.sessionCwd,
          timeout: params.timeout,
        });
        return {
          content: [
            {
              type: "text",
              text:
                `Agent run started: ${run.id}\n` +
                `Definition: ${run.definitionId}\n` +
                `Cwd: ${run.cwd}\n` +
                `The run executes in the background; completion is announced in this session.`,
            },
          ],
          details: undefined,
        };
      } catch (err) {
        return {
          content: [
            {
              type: "text",
              text: `Failed to start agent run: ${err instanceof Error ? err.message : String(err)}`,
            },
          ],
          details: undefined,
        };
      }
    },
  };
}

const agentStatusSchema = Type.Object({
  runId: Type.Optional(
    Type.String({
      description:
        "Run id to inspect (returns status plus recent output). Omit to list all active runs for this session.",
    }),
  ),
});

function createAgentStatusTool(ctx: SessionContext): AgentTool<typeof agentStatusSchema, undefined> {
  return {
    name: "agent_status",
    label: "Background Agent Status",
    description:
      "Check background agent runs. Without a runId, lists this session's active runs. " +
      "With a runId, returns that run's real status and the tail of its output. " +
      "Always use this instead of guessing what a background run is doing.",
    parameters: agentStatusSchema,
    execute: async (_toolCallId, params): Promise<AgentToolResult<undefined>> => {
      try {
        const { findRunById, listActiveRuns, readOutput } = await import("./agents/memory.js");

        if (params.runId) {
          const found = await findRunById(params.runId);
          if (!found) {
            return {
              content: [
                {
                  type: "text",
                  text: `No active run found with id ${params.runId}. It may have completed (results are announced in chat) or the id may be wrong.`,
                },
              ],
              details: undefined,
            };
          }
          const output = await readOutput(found.session, found.run.id);
          const tail = output.length > 3000 ? `…${output.slice(-3000)}` : output;
          const r = found.run;
          return {
            content: [
              {
                type: "text",
                text:
                  `Run ${r.id}\nStatus: ${r.status}\nStarted: ${r.started}` +
                  `${r.ended ? `\nEnded: ${r.ended}` : ""}` +
                  `${r.error ? `\nError: ${r.error}` : ""}` +
                  `\nTask: ${r.userPrompt}\n\nOutput tail:\n${tail || "(no output yet)"}`,
              },
            ],
            details: undefined,
          };
        }

        const runs = await listActiveRuns(ctx.sessionName);
        if (runs.length === 0) {
          return {
            content: [
              { type: "text", text: "No active background agent runs for this session." },
            ],
            details: undefined,
          };
        }
        const lines = runs.map(
          (r) => `- ${r.id} [${r.status}] started ${r.started}: ${r.userPrompt.slice(0, 100)}`,
        );
        return {
          content: [{ type: "text", text: `Active runs:\n${lines.join("\n")}` }],
          details: undefined,
        };
      } catch (err) {
        return {
          content: [
            {
              type: "text",
              text: `Failed to check agent status: ${err instanceof Error ? err.message : String(err)}`,
            },
          ],
          details: undefined,
        };
      }
    },
  };
}

const agentAnswerSchema = Type.Object({
  runId: Type.String({ description: "Run id that asked the question" }),
  answer: Type.String({
    description: "The user's answer to forward to the waiting run",
  }),
});

function createAgentAnswerTool(): AgentTool<typeof agentAnswerSchema, undefined> {
  return {
    name: "agent_answer",
    label: "Answer Background Agent",
    description:
      "Forward the user's answer to a background agent run that is waiting on an " +
      "ask_user question (status waiting_input). When a run has asked a question and " +
      "the user replies, call this with the run id and their answer so the run can continue.",
    parameters: agentAnswerSchema,
    execute: async (_toolCallId, params): Promise<AgentToolResult<undefined>> => {
      try {
        const { getAgentManager } = await import("./agents/manager.js");
        const ok = await getAgentManager().answerRun(params.runId, params.answer);
        return {
          content: [
            {
              type: "text",
              text: ok
                ? `Answer delivered to run ${params.runId}; it will continue now.`
                : `Run ${params.runId} has no pending question (not active or not waiting for input).`,
            },
          ],
          details: undefined,
        };
      } catch (err) {
        return {
          content: [
            {
              type: "text",
              text: `Failed to answer run: ${err instanceof Error ? err.message : String(err)}`,
            },
          ],
          details: undefined,
        };
      }
    },
  };
}

const agentSteerSchema = Type.Object({
  runId: Type.String({ description: "Run id to steer" }),
  message: Type.String({
    description: "Instruction to inject into the running agent",
  }),
});

function createAgentSteerTool(): AgentTool<typeof agentSteerSchema, undefined> {
  return {
    name: "agent_steer",
    label: "Steer Background Agent",
    description:
      "Queue a steering instruction into a running background agent (course-correct, " +
      "add context, change direction) without stopping it. Delivered after the run's " +
      "current turn. Use agent_status first to confirm the run is still active.",
    parameters: agentSteerSchema,
    execute: async (_toolCallId, params): Promise<AgentToolResult<undefined>> => {
      try {
        const { getAgentManager } = await import("./agents/manager.js");
        const ok = await getAgentManager().steerRun(params.runId, params.message);
        return {
          content: [
            {
              type: "text",
              text: ok
                ? `Steering message queued for run ${params.runId}.`
                : `Run ${params.runId} is not active — cannot steer.`,
            },
          ],
          details: undefined,
        };
      } catch (err) {
        return {
          content: [
            {
              type: "text",
              text: `Failed to steer run: ${err instanceof Error ? err.message : String(err)}`,
            },
          ],
          details: undefined,
        };
      }
    },
  };
}

const agentStopSchema = Type.Object({
  runId: Type.String({ description: "Run id to stop" }),
});

function createAgentStopTool(): AgentTool<typeof agentStopSchema, undefined> {
  return {
    name: "agent_stop",
    label: "Stop Background Agent",
    description:
      "Stop a running background agent run. Aborts gracefully via RPC first, then " +
      "kills the process after a grace period. Use when the user asks to cancel or " +
      "stop a run. Use agent_status first if unsure of the run id.",
    parameters: agentStopSchema,
    execute: async (_toolCallId, params): Promise<AgentToolResult<undefined>> => {
      try {
        const { getAgentManager } = await import("./agents/manager.js");
        const ok = await getAgentManager().stopRun(params.runId);
        return {
          content: [
            {
              type: "text",
              text: ok
                ? `Stop requested for run ${params.runId}; its final status will be announced in chat.`
                : `Run ${params.runId} not found — it may have already completed.`,
            },
          ],
          details: undefined,
        };
      } catch (err) {
        return {
          content: [
            {
              type: "text",
              text: `Failed to stop run: ${err instanceof Error ? err.message : String(err)}`,
            },
          ],
          details: undefined,
        };
      }
    },
  };
}

// ============================================================================
// Export tools factory
// ============================================================================

// ============================================================================
// canvas_create tool
// ============================================================================

const canvasCreateSchema = Type.Object({
  title: Type.Optional(Type.String({ description: "Canvas title" })),
  markdown: Type.String({ description: "Markdown content for the canvas body" }),
  share_to_channel: Type.Optional(Type.Boolean({ description: "Share to current channel (default true)" })),
});

export interface CanvasChange {
  operation: "insert_at_start" | "insert_at_end" | "insert_before" | "insert_after" | "replace" | "delete";
  section_id?: string;
  markdown?: string;
}

export interface CanvasCallbacks {
  create: (args: { title?: string; markdown: string; channelId?: string }) => Promise<{ canvas_id: string }>;
  edit: (args: { canvas_id: string; changes: CanvasChange[] }) => Promise<void>;
  sectionsLookup: (args: { canvas_id: string; criteria: { section_types?: string[]; contains_text?: string } }) => Promise<Array<{ id: string }>>;
}

function createCanvasCreateTool(
  callbacks: CanvasCallbacks,
  channelId?: string
): AgentTool<typeof canvasCreateSchema> {
  return {
    name: "canvas_create",
    label: "Creating canvas",
    description: "Create a Slack canvas with markdown content. Returns a canvas_id you can use with canvas_edit and canvas_sections_lookup.",
    parameters: canvasCreateSchema,
    execute: async (_toolCallId: string, params: Static<typeof canvasCreateSchema>): Promise<AgentToolResult<undefined>> => {
      try {
        const shareToChannel = params.share_to_channel !== false;
        const result = await callbacks.create({
          title: params.title,
          markdown: params.markdown,
          channelId: shareToChannel ? channelId : undefined,
        });
        return {
          content: [{ type: "text", text: `Canvas created. canvas_id: ${result.canvas_id}` }],
          details: undefined,
        };
      } catch (err: any) {
        return {
          content: [{ type: "text", text: `canvas_create error: ${err.message || String(err)}` }],
          details: undefined,
        };
      }
    },
  };
}

// ============================================================================
// canvas_edit tool
// ============================================================================

const canvasChangeSchema = Type.Object({
  operation: Type.Union([
    Type.Literal("insert_at_start"),
    Type.Literal("insert_at_end"),
    Type.Literal("insert_before"),
    Type.Literal("insert_after"),
    Type.Literal("replace"),
    Type.Literal("delete"),
  ], { description: "Edit operation to perform" }),
  section_id: Type.Optional(Type.String({ description: "Target section ID (required for insert_before, insert_after, replace, delete)" })),
  markdown: Type.Optional(Type.String({ description: "Markdown content (required for all operations except delete)" })),
});

const canvasEditSchema = Type.Object({
  canvas_id: Type.String({ description: "ID of the canvas to edit" }),
  changes: Type.Array(canvasChangeSchema, { description: "Array of changes to apply" }),
});

function createCanvasEditTool(
  callbacks: CanvasCallbacks
): AgentTool<typeof canvasEditSchema> {
  return {
    name: "canvas_edit",
    label: "Editing canvas",
    description: "Edit an existing Slack canvas by inserting, replacing, or deleting sections.",
    parameters: canvasEditSchema,
    execute: async (_toolCallId: string, params: Static<typeof canvasEditSchema>): Promise<AgentToolResult<undefined>> => {
      try {
        await callbacks.edit({ canvas_id: params.canvas_id, changes: params.changes as CanvasChange[] });
        return {
          content: [{ type: "text", text: `Canvas ${params.canvas_id} updated successfully.` }],
          details: undefined,
        };
      } catch (err: any) {
        return {
          content: [{ type: "text", text: `canvas_edit error: ${err.message || String(err)}` }],
          details: undefined,
        };
      }
    },
  };
}

// ============================================================================
// canvas_sections_lookup tool
// ============================================================================

const canvasSectionsLookupSchema = Type.Object({
  canvas_id: Type.String({ description: "ID of the canvas to inspect" }),
  section_types: Type.Optional(Type.Array(Type.String(), { description: "Filter by type: any_header, h1, h2, h3" })),
  contains_text: Type.Optional(Type.String({ description: "Filter sections containing this text" })),
});

function createCanvasSectionsLookupTool(
  callbacks: CanvasCallbacks
): AgentTool<typeof canvasSectionsLookupSchema> {
  return {
    name: "canvas_sections_lookup",
    label: "Looking up canvas sections",
    description: "Look up section IDs in a Slack canvas. Use this before canvas_edit when you need to target specific sections.",
    parameters: canvasSectionsLookupSchema,
    execute: async (_toolCallId: string, params: Static<typeof canvasSectionsLookupSchema>): Promise<AgentToolResult<undefined>> => {
      try {
        const sections = await callbacks.sectionsLookup({
          canvas_id: params.canvas_id,
          criteria: {
            section_types: params.section_types,
            contains_text: params.contains_text,
          },
        });
        return {
          content: [{ type: "text", text: JSON.stringify(sections) }],
          details: undefined,
        };
      } catch (err: any) {
        return {
          content: [{ type: "text", text: `canvas_sections_lookup error: ${err.message || String(err)}` }],
          details: undefined,
        };
      }
    },
  };
}

const sendMessageSchema = Type.Object({
  message: Type.String({
    description: "The message text to send to the current chat",
  }),
});

/**
 * Lets the agent push a message mid-run instead of only at the end of its turn.
 *
 * Without this, a run that kicks off long work can only report "starting..." —
 * the harness delivers exactly one reply per run, so any follow-up the agent
 * wanted to send had nowhere to go.
 *
 * Always targets the session the run belongs to; the agent cannot pick an
 * arbitrary recipient.
 */
function createSendMessageTool(
  ctx: SessionContext,
  notify: (message: string) => Promise<void>
): AgentTool<typeof sendMessageSchema> {
  return {
    name: "send_message",
    label: "Send Message",
    description: `Send a message to the current chat right now, without ending your turn.

Use this when a task will take a while and the user should not be left waiting in silence
(send a short progress note, keep working, then continue as normal), or to reach out
proactively — e.g. alerting the user after finishing a long background task.

IMPORTANT: your final response is delivered automatically when your turn ends. Do not use
this tool to send that final answer — it would arrive twice. This is for progress updates,
intermediate results, and unprompted outreach only.`,
    parameters: sendMessageSchema,
    execute: async (_toolCallId: string, params: Static<typeof sendMessageSchema>): Promise<AgentToolResult<undefined>> => {
      const text = params.message?.trim();
      if (!text) {
        return {
          content: [{ type: "text", text: "Error: message is required" }],
          details: undefined,
        };
      }
      try {
        console.log(`[send_message] Sending interim message to ${ctx.sessionName} (${text.length} chars)`);
        await notify(text);
        return {
          content: [{ type: "text", text: "Message sent." }],
          details: undefined,
        };
      } catch (err: any) {
        return {
          content: [{ type: "text", text: `Failed to send: ${err.message || String(err)}` }],
          details: undefined,
        };
      }
    },
  };
}

/**
 * Wrap a tool so calls matching the session's approvals.json rules pause for
 * an Approve/Deny click in Slack before executing. Reads and unmatched calls
 * pass straight through. Config is re-read per call, so edits apply live.
 */
function withApprovalGate(tool: AgentTool<any>, sessionName: string): AgentTool<any> {
  const execute = tool.execute;
  return {
    ...tool,
    execute: async (toolCallId: string, params: any, signal?: AbortSignal): Promise<AgentToolResult<any>> => {
      // Lazy import to avoid a circular dependency at module load time
      const approvals = await import("./approvals.js");
      const config = approvals.loadApprovalConfig(sessionName);
      const descriptor = approvals.callDescriptor(tool.name, params);
      if (!approvals.requiresApproval(config, descriptor)) {
        return execute(toolCallId, params, signal as any);
      }

      const argsJson = JSON.stringify(params ?? {}, null, 2);
      const summary = `*${tool.label ?? tool.name}*\n\`\`\`${argsJson.slice(0, 1500)}\`\`\``;
      console.log(`[approvals] Gated call ${descriptor} in ${sessionName}, awaiting approval`);
      const outcome = await approvals.getApprovalManager().requestApproval({
        sessionName,
        descriptor,
        summary,
        timeoutSeconds: config!.timeoutSeconds,
      });

      if (!outcome.approved) {
        const reason = outcome.timedOut ? "the approval request timed out" : "a human denied the request";
        return {
          content: [{ type: "text", text: `Call to ${descriptor} was NOT executed: ${reason}. Do not retry the same call; tell the user and ask how to proceed.` }],
          details: undefined,
        };
      }
      console.log(`[approvals] ${descriptor} approved${outcome.by ? ` by ${outcome.by}` : ""}`);
      return execute(toolCallId, params, signal as any);
    },
  };
}

/**
 * Create all tools for a session with proper sandbox isolation.
 * Each session gets its own tool instances with sessionCwd captured in closures.
 * This prevents race conditions when multiple sessions run concurrently.
 */
export function createTools(
  sessionName: string,
  options?: {
    notify?: (message: string) => Promise<void>;
    channelId?: string;
    canvas?: CanvasCallbacks;
  }
): AgentTool<any>[] {
  const ctx = createSessionContext(sessionName);
  const tools: AgentTool<any>[] = [
    createReadFileTool(ctx),
    createWriteFileTool(ctx),
    createListDirTool(ctx),
    createBashTool(ctx),
    createSearchTool(ctx),
    // These tools don't need session context (no sandbox paths)
    webSearchTool,
    webFetchTool,
    getCurrentTimeTool,
    createRenderUiTool(ctx),
    createRenderChartTool(ctx),
    createRenderDiagramTool(ctx),
    // These tools need session context
    createAttachTool(ctx),
    createGenerateImageTool(ctx),
    createEditImageTool(ctx),
    createMcpTool(ctx),
    // Background agent delegation (pi --rlm runs)
    createAgentRunTool(ctx),
    createAgentStatusTool(ctx),
    createAgentAnswerTool(),
    createAgentSteerTool(),
    createAgentStopTool(),
  ];
  if (options?.notify) {
    tools.push(createSendMessageTool(ctx, options.notify));
  }
  if (options?.canvas) {
    tools.push(createCanvasCreateTool(options.canvas, options.channelId));
    tools.push(createCanvasEditTool(options.canvas));
    tools.push(createCanvasSectionsLookupTool(options.canvas));
  }
  // Approval gate wraps under the original (pre-rename) tool names so
  // approvals.json rules stay stable regardless of OAuth renames.
  return renameBlockedToolsForOAuth(tools.map((t) => withApprovalGate(t, sessionName)));
}

/**
 * @deprecated Use createTools(sessionName) instead.
 * This function exists for backward compatibility but returns tools without proper session isolation.
 */
export function getTools(options?: { cwd?: string }): AgentTool<any>[] {
  console.warn("[pi-agent-tools] WARNING: getTools() is deprecated, use createTools(sessionName) for proper session isolation");
  // Fallback to a default session - this is unsafe for concurrent use
  return createTools("@unknown");
}

/**
 * @deprecated Legacy exports for backward compatibility.
 * Use createTools(sessionName) instead.
 */
export const allTools: AgentTool<any>[] = createTools("@unknown");

// Legacy exports - deprecated
export const readFileTool = allTools.find(t => t.name === "read_file")!;
export const writeFileTool = allTools.find(t => t.name === "write_file")!;
export const listDirTool = allTools.find(t => t.name === "list_directory")!;
export const bashTool = allTools.find(t => t.name === "bash")!;
export const searchTool = allTools.find(t => t.name === "search")!;
export const attachTool = allTools.find(t => t.name === "attach")!;
