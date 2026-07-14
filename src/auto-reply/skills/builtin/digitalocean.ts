// DigitalOcean App Platform skill
// Provides tools for interacting with DO App Platform via their REST API

import { Type } from "@sinclair/typebox";
import type { AgentTool, AgentToolResult } from "@earendil-works/pi-agent-core";
import type { TextContent } from "@earendil-works/pi-ai";
import type { ProgrammaticSkill } from "../types.js";

const DO_API_BASE = "https://api.digitalocean.com/v2";

function getApiKey(): string | null {
  return process.env.DIGITALOCEAN_API_KEY || process.env.DO_API_KEY || null;
}

async function doFetch(endpoint: string, options: RequestInit = {}): Promise<any> {
  const apiKey = getApiKey();
  if (!apiKey) {
    throw new Error("DIGITALOCEAN_API_KEY or DO_API_KEY environment variable not set");
  }

  const url = `${DO_API_BASE}${endpoint}`;
  const response = await fetch(url, {
    ...options,
    headers: {
      "Authorization": `Bearer ${apiKey}`,
      "Content-Type": "application/json",
      ...options.headers,
    },
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`DO API ${response.status}: ${errorText}`);
  }

  return response.json();
}

// ============================================================================
// List Apps Tool
// ============================================================================

const listAppsSchema = Type.Object({
  page: Type.Optional(Type.Number({ description: "Page number (default: 1)" })),
  per_page: Type.Optional(Type.Number({ description: "Results per page (default: 20, max: 200)" })),
});

const listAppsTool: AgentTool<typeof listAppsSchema, undefined> = {
  name: "do_list_apps",
  label: "DO List Apps",
  description: "List all DigitalOcean App Platform apps. Returns app IDs, names, and status.",
  parameters: listAppsSchema,
  execute: async (_toolCallId, params): Promise<AgentToolResult<undefined>> => {
    try {
      const page = params.page ?? 1;
      const perPage = params.per_page ?? 20;

      console.log(`[do_list_apps] Listing apps (page ${page})`);
      const data = await doFetch(`/apps?page=${page}&per_page=${perPage}`);

      if (!data.apps || data.apps.length === 0) {
        return {
          content: [{ type: "text", text: "No apps found" }],
          details: undefined,
        };
      }

      const appList = data.apps.map((app: any) => {
        const status = app.active_deployment?.phase || "unknown";
        const region = app.region?.slug || "unknown";
        return `- **${app.spec?.name || "unnamed"}** (ID: ${app.id})\n  Region: ${region} | Status: ${status} | Created: ${app.created_at}`;
      }).join("\n\n");

      const total = data.meta?.total || data.apps.length;
      return {
        content: [{ type: "text", text: `## Apps (${data.apps.length} of ${total})\n\n${appList}` }],
        details: undefined,
      };
    } catch (err: any) {
      return {
        content: [{ type: "text", text: `Error listing apps: ${err.message}` }],
        details: undefined,
      };
    }
  },
};

// ============================================================================
// App Logs Tool
// ============================================================================

const appLogsSchema = Type.Object({
  app_id: Type.String({ description: "App ID (use do_list_apps to find)" }),
  deployment_id: Type.Optional(Type.String({ description: "Deployment ID (default: latest)" })),
  component: Type.Optional(Type.String({ description: "Component name (default: all components)" })),
  type: Type.Optional(Type.Union([
    Type.Literal("BUILD"),
    Type.Literal("DEPLOY"),
    Type.Literal("RUN"),
  ], { description: "Log type: BUILD, DEPLOY, or RUN (default: RUN)" })),
  tail: Type.Optional(Type.Number({ description: "Number of lines to fetch (default: 100)" })),
});

const appLogsTool: AgentTool<typeof appLogsSchema, undefined> = {
  name: "do_app_logs",
  label: "DO App Logs",
  description: "Get logs for a DigitalOcean App Platform app. Supports build, deploy, and runtime logs.",
  parameters: appLogsSchema,
  execute: async (_toolCallId, params): Promise<AgentToolResult<undefined>> => {
    try {
      const { app_id, component, type = "RUN", tail = 100 } = params;
      let { deployment_id } = params;

      // If no deployment_id, get the latest deployment
      if (!deployment_id) {
        console.log(`[do_app_logs] Getting latest deployment for app ${app_id}`);
        const deploymentsData = await doFetch(`/apps/${app_id}/deployments?per_page=1`);
        if (!deploymentsData.deployments || deploymentsData.deployments.length === 0) {
          return {
            content: [{ type: "text", text: "No deployments found for this app" }],
            details: undefined,
          };
        }
        deployment_id = deploymentsData.deployments[0].id;
      }

      // Build the logs endpoint
      let endpoint = `/apps/${app_id}/deployments/${deployment_id}`;
      if (component) {
        endpoint += `/components/${component}`;
      }
      endpoint += `/logs?type=${type}&follow=false`;

      console.log(`[do_app_logs] Fetching ${type} logs for app ${app_id}, deployment ${deployment_id}`);
      const data = await doFetch(endpoint);

      // The API returns a URL to fetch actual logs
      if (data.historic_urls && data.historic_urls.length > 0) {
        // Fetch the actual log content
        const logUrl = data.historic_urls[0];
        const logResponse = await fetch(logUrl);
        if (!logResponse.ok) {
          return {
            content: [{ type: "text", text: `Failed to fetch log content: ${logResponse.status}` }],
            details: undefined,
          };
        }
        let logText = await logResponse.text();

        // Limit to tail lines
        const lines = logText.split("\n");
        if (lines.length > tail) {
          logText = `... (${lines.length - tail} lines truncated)\n\n` + lines.slice(-tail).join("\n");
        }

        return {
          content: [{ type: "text", text: `## ${type} Logs (deployment: ${deployment_id})\n\n\`\`\`\n${logText}\n\`\`\`` }],
          details: undefined,
        };
      }

      // If live_url is provided instead (for streaming)
      if (data.live_url) {
        return {
          content: [{ type: "text", text: `Live logs URL: ${data.live_url}\n\nNote: Live streaming not supported in this tool. Use historic logs or check the DO console.` }],
          details: undefined,
        };
      }

      return {
        content: [{ type: "text", text: "No log data available" }],
        details: undefined,
      };
    } catch (err: any) {
      return {
        content: [{ type: "text", text: `Error fetching logs: ${err.message}` }],
        details: undefined,
      };
    }
  },
};

// ============================================================================
// App Spec Tool
// ============================================================================

const appSpecSchema = Type.Object({
  app_id: Type.String({ description: "App ID (use do_list_apps to find)" }),
  format: Type.Optional(Type.Union([
    Type.Literal("yaml"),
    Type.Literal("json"),
  ], { description: "Output format: yaml or json (default: yaml)" })),
});

const appSpecTool: AgentTool<typeof appSpecSchema, undefined> = {
  name: "do_app_spec",
  label: "DO App Spec",
  description: "Get the app spec for a DigitalOcean App Platform app.",
  parameters: appSpecSchema,
  execute: async (_toolCallId, params): Promise<AgentToolResult<undefined>> => {
    try {
      const { app_id, format = "yaml" } = params;

      console.log(`[do_app_spec] Getting spec for app ${app_id}`);
      const data = await doFetch(`/apps/${app_id}`);

      if (!data.app || !data.app.spec) {
        return {
          content: [{ type: "text", text: "No spec found for this app" }],
          details: undefined,
        };
      }

      const spec = data.app.spec;
      let output: string;

      if (format === "yaml") {
        // Simple YAML-like output (no external deps)
        output = formatAsYaml(spec);
      } else {
        output = JSON.stringify(spec, null, 2);
      }

      return {
        content: [{ type: "text", text: `## App Spec: ${spec.name || app_id}\n\n\`\`\`${format}\n${output}\n\`\`\`` }],
        details: undefined,
      };
    } catch (err: any) {
      return {
        content: [{ type: "text", text: `Error fetching app spec: ${err.message}` }],
        details: undefined,
      };
    }
  },
};

// Simple YAML formatter (avoids external dependency)
function formatAsYaml(obj: any, indent = 0): string {
  const spaces = "  ".repeat(indent);
  const lines: string[] = [];

  for (const [key, value] of Object.entries(obj)) {
    if (value === null || value === undefined) {
      lines.push(`${spaces}${key}: null`);
    } else if (Array.isArray(value)) {
      if (value.length === 0) {
        lines.push(`${spaces}${key}: []`);
      } else {
        lines.push(`${spaces}${key}:`);
        for (const item of value) {
          if (typeof item === "object" && item !== null) {
            lines.push(`${spaces}- `);
            const itemYaml = formatAsYaml(item, indent + 2);
            // Adjust first line of object to be on same line as dash
            const itemLines = itemYaml.split("\n");
            if (itemLines.length > 0) {
              lines[lines.length - 1] += itemLines[0].trim();
              lines.push(...itemLines.slice(1));
            }
          } else {
            lines.push(`${spaces}- ${item}`);
          }
        }
      }
    } else if (typeof value === "object") {
      lines.push(`${spaces}${key}:`);
      lines.push(formatAsYaml(value, indent + 1));
    } else if (typeof value === "string" && (value.includes("\n") || value.includes(":"))) {
      lines.push(`${spaces}${key}: "${value.replace(/"/g, '\\"')}"`);
    } else {
      lines.push(`${spaces}${key}: ${value}`);
    }
  }

  return lines.join("\n");
}

// ============================================================================
// List Deployments Tool
// ============================================================================

const listDeploymentsSchema = Type.Object({
  app_id: Type.String({ description: "App ID (use do_list_apps to find)" }),
  page: Type.Optional(Type.Number({ description: "Page number (default: 1)" })),
  per_page: Type.Optional(Type.Number({ description: "Results per page (default: 10)" })),
});

const listDeploymentsTool: AgentTool<typeof listDeploymentsSchema, undefined> = {
  name: "do_list_deployments",
  label: "DO List Deployments",
  description: "List deployments for a DigitalOcean App Platform app.",
  parameters: listDeploymentsSchema,
  execute: async (_toolCallId, params): Promise<AgentToolResult<undefined>> => {
    try {
      const { app_id, page = 1, per_page = 10 } = params;

      console.log(`[do_list_deployments] Listing deployments for app ${app_id}`);
      const data = await doFetch(`/apps/${app_id}/deployments?page=${page}&per_page=${per_page}`);

      if (!data.deployments || data.deployments.length === 0) {
        return {
          content: [{ type: "text", text: "No deployments found" }],
          details: undefined,
        };
      }

      const deploymentList = data.deployments.map((d: any) => {
        const phase = d.phase || "unknown";
        const cause = d.cause || "manual";
        const progress = d.progress?.steps_completed
          ? `${d.progress.steps_completed}/${d.progress.total_steps} steps`
          : "";
        return `- **${d.id}**\n  Phase: ${phase} | Cause: ${cause} | Created: ${d.created_at}${progress ? ` | Progress: ${progress}` : ""}`;
      }).join("\n\n");

      return {
        content: [{ type: "text", text: `## Deployments for ${app_id}\n\n${deploymentList}` }],
        details: undefined,
      };
    } catch (err: any) {
      return {
        content: [{ type: "text", text: `Error listing deployments: ${err.message}` }],
        details: undefined,
      };
    }
  },
};

// ============================================================================
// List Alerts Tool
// ============================================================================

const listAlertsSchema = Type.Object({
  app_id: Type.String({ description: "App ID (use do_list_apps to find)" }),
});

const listAlertsTool: AgentTool<typeof listAlertsSchema, undefined> = {
  name: "do_list_alerts",
  label: "DO List Alerts",
  description: "List alerts configured for a DigitalOcean App Platform app.",
  parameters: listAlertsSchema,
  execute: async (_toolCallId, params): Promise<AgentToolResult<undefined>> => {
    try {
      const { app_id } = params;

      console.log(`[do_list_alerts] Listing alerts for app ${app_id}`);
      const data = await doFetch(`/apps/${app_id}/alerts`);

      if (!data.alerts || data.alerts.length === 0) {
        return {
          content: [{ type: "text", text: "No alerts configured for this app" }],
          details: undefined,
        };
      }

      const alertList = data.alerts.map((a: any) => {
        const rule = a.spec?.rule || "unknown";
        const component = a.spec?.component_name || "app-level";
        const disabled = a.spec?.disabled ? " (disabled)" : "";
        const emails = a.emails?.join(", ") || "none";
        const slackWebhooks = a.slack_webhooks?.length || 0;
        return `- **${rule}**${disabled}\n  Component: ${component} | Emails: ${emails} | Slack webhooks: ${slackWebhooks}`;
      }).join("\n\n");

      return {
        content: [{ type: "text", text: `## Alerts for ${app_id}\n\n${alertList}` }],
        details: undefined,
      };
    } catch (err: any) {
      return {
        content: [{ type: "text", text: `Error listing alerts: ${err.message}` }],
        details: undefined,
      };
    }
  },
};

// ============================================================================
// Export Skill
// ============================================================================

export const digitaloceanSkill: ProgrammaticSkill = {
  name: "digitalocean",
  description: "DigitalOcean App Platform tools - list apps, view logs, specs, deployments, and alerts",
  tools: [
    listAppsTool,
    appLogsTool,
    appSpecTool,
    listDeploymentsTool,
    listAlertsTool,
  ],
  systemPromptAddition: `## DigitalOcean App Platform
You have access to DigitalOcean App Platform tools:
- \`do_list_apps\`: List all apps (get app IDs here first)
- \`do_app_logs\`: Get build/deploy/runtime logs for an app
- \`do_app_spec\`: Get the app spec (YAML or JSON)
- \`do_list_deployments\`: List deployment history
- \`do_list_alerts\`: List configured alerts

**Usage flow**: Always use \`do_list_apps\` first to get the app ID, then use other tools with that ID.
Requires DIGITALOCEAN_API_KEY or DO_API_KEY environment variable.`,
};
