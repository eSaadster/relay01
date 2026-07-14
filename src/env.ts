// Environment configuration for relay01.
// Slack credentials are read from the environment (SLACK_APP_TOKEN /
// SLACK_BOT_TOKEN); see the README for the full list of variables.

import { defaultRuntime, type RuntimeEnv } from "./runtime.js";

export type EnvConfig = {
  // No additional service configuration is resolved here; Slack tokens and
  // per-session overrides are loaded directly from the environment / .env files.
};

export function readEnv(runtime: RuntimeEnv = defaultRuntime): EnvConfig {
  return {};
}

export function ensureEnv(runtime: RuntimeEnv = defaultRuntime): void {
  // No external dependencies to verify up front.
  readEnv(runtime);
}
