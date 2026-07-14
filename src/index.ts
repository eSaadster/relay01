#!/usr/bin/env node
import process from "node:process";
import { fileURLToPath } from "node:url";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

import dotenv from "dotenv";
import { createDefaultDeps } from "./cli/deps.js";
import { loadConfig } from "./config/config.js";
import { readEnv, ensureEnv } from "./env.js";
import { ensureBinary } from "./infra/binaries.js";
import {
  describePortOwner,
  ensurePortAvailable,
  handlePortError,
  PortInUseError,
} from "./infra/ports.js";
import { runCommandWithTimeout, runExec } from "./process/exec.js";

/**
 * Hierarchical .env loading (similar to SYSTEM.md and mcporter.json):
 * 1. Project .env (lowest priority - defaults)
 * 2. Global ~/relay01/slack/.env (higher priority - user overrides)
 *
 * Session-specific .env files are loaded per-request via loadSessionEnv()
 */
function loadHierarchicalEnv(): void {
  // 1. Load project .env first (defaults)
  dotenv.config({ override: false });

  // 2. Overlay with global ~/relay01/slack/.env (user overrides)
  const globalEnvPath = join(homedir(), "relay01", "slack", ".env");
  if (existsSync(globalEnvPath)) {
    dotenv.config({ path: globalEnvPath, override: true });
  }
}

/**
 * Load session-specific .env for a given session.
 * Call this when creating a session to load session-specific overrides.
 * Path: ~/relay01/slack/{sessionName}/.env
 */
function loadSessionEnv(sessionName: string): void {
  const sessionEnvVars = [
    "PI_AGENT_MODEL",
    "SKIP_CONTEXT_WARMUP",
    "COMPOSIO_API_KEY",
  ];
  for (const key of sessionEnvVars) {
    delete process.env[key];
  }

  const sessionEnvPath = join(homedir(), "relay01", "slack", sessionName, ".env");
  if (existsSync(sessionEnvPath)) {
    dotenv.config({ path: sessionEnvPath, override: true });
  }
}

loadHierarchicalEnv();

import { buildProgram } from "./cli/program.js";

const program = buildProgram();

export {
  createDefaultDeps,
  describePortOwner,
  ensureBinary,
  ensureEnv,
  ensurePortAvailable,
  handlePortError,
  loadConfig,
  loadSessionEnv,
  PortInUseError,
  readEnv,
  runCommandWithTimeout,
  runExec,
  program,
};

const isMain =
  process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];

if (isMain) {
  // Global error handlers to prevent silent crashes from unhandled rejections/exceptions.
  // These log the error and exit gracefully instead of crashing without trace.
  process.on("unhandledRejection", (reason, _promise) => {
    console.error(
      "[relay01] Unhandled promise rejection:",
      reason instanceof Error ? (reason.stack ?? reason.message) : reason,
    );
    process.exit(1);
  });

  process.on("uncaughtException", (error) => {
    console.error(
      "[relay01] Uncaught exception:",
      error.stack ?? error.message,
    );
    process.exit(1);
  });

  program.parseAsync(process.argv);
}
