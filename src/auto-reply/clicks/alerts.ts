// Click alert delivery via Slack

import { logVerbose } from "../../globals.js";
import type {
  ClickConfig,
  ClickContext,
  ClickResult,
  ClickSchedulerConfig,
} from "./types.js";

/**
 * Format an alert message for Slack.
 */
function formatAlertMessage(click: ClickConfig, result: ClickResult): string {
  const timestamp = new Date(result.timestamp).toISOString();

  return `:bell: *Click Alert: ${click.name}*

${result.summary}

> ${result.details.slice(0, 500)}${result.details.length > 500 ? "..." : ""}

_Click ID: \`${click.id}\` | ${timestamp}_`;
}

/**
 * Resolve the Slack channel ID for an alert target.
 */
async function resolveAlertTarget(
  config: ClickSchedulerConfig,
  ctx: ClickContext
): Promise<string | null> {
  const target = ctx.alertTarget;

  // If it's already a channel ID (starts with C, D, or G)
  if (/^[CDG][A-Z0-9]+$/.test(target)) {
    return target;
  }

  // If it's a channel name (starts with #)
  if (target.startsWith("#")) {
    const channelName = target.slice(1); // Remove #
    const channelId = config.getChannelByName(channelName);
    if (channelId) {
      return channelId;
    }
    console.warn(`[clicks] Cannot resolve channel ${target}`);
    return null;
  }

  // If it's a session name (@username), we need to find/create DM
  if (target.startsWith("@")) {
    if (config.getSessionChannelId) {
      const channelId = await config.getSessionChannelId(target);
      if (channelId) {
        return channelId;
      }
    }
    console.warn(
      `[clicks] Cannot resolve DM for ${target} - getSessionChannelId not configured`
    );
    return null;
  }

  // Try as-is (might be a direct channel ID)
  return target;
}

/**
 * Send a click alert to Slack.
 */
export async function sendClickAlert(
  config: ClickSchedulerConfig,
  ctx: ClickContext,
  click: ClickConfig,
  result: ClickResult
): Promise<void> {
  const channelId = await resolveAlertTarget(config, ctx);

  if (!channelId) {
    console.error(
      `[clicks] Cannot send alert for ${click.id}: unable to resolve target ${ctx.alertTarget}`
    );
    return;
  }

  const message = formatAlertMessage(click, result);

  logVerbose(`Sending click alert to ${channelId}: ${click.name}`);

  try {
    await config.webClient.chat.postMessage({
      channel: channelId,
      text: message,
      unfurl_links: false,
      unfurl_media: false,
    });

    console.log(
      `[clicks] Alert sent for ${click.id} to ${ctx.alertTarget}`
    );
  } catch (err) {
    console.error(
      `[clicks] Failed to send alert to ${channelId}: ${err}`
    );
    throw err;
  }
}
