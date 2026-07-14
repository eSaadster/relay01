// CLI Dependencies for Slack bot

import { info } from "../globals.js";
import { ensureBinary } from "../infra/binaries.js";
import { ensurePortAvailable, handlePortError } from "../infra/ports.js";
import { defaultRuntime, type RuntimeEnv } from "../runtime.js";
import { waitForever } from "./wait.js";

export type CliDeps = {
  ensurePortAvailable: typeof ensurePortAvailable;
  waitForever: typeof waitForever;
  ensureBinary: typeof ensureBinary;
  handlePortError: typeof handlePortError;
};

export function createDefaultDeps(): CliDeps {
  // Default dependency bundle used by CLI commands and tests.
  return {
    ensurePortAvailable,
    waitForever,
    ensureBinary,
    handlePortError,
  };
}

export function logProviderInfo(runtime: RuntimeEnv = defaultRuntime) {
  runtime.log(info("Provider: Slack (Socket Mode)"));
}
