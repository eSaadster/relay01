#!/usr/bin/env node

import { join, resolve } from "path";
import * as log from "./log.js";
import { MomBot, type SlackContext, type FeedbackEvent, type BlockActionEvent } from "./slack.js";
import { getApprovalManager } from "../auto-reply/approvals.js";
import { getPiAgentManager, PiAgentManager, type PiAgentConfig, type ToolActivity } from "../auto-reply/pi-agent.js";
import { type Step, renderStepChecklist } from "./checklist.js";
import { initializeSkills } from "../auto-reply/skills/index.js";
import { getClickScheduler } from "../auto-reply/clicks/index.js";
import { getEventsWatcher } from "../auto-reply/events/index.js";
import { setUploadFunction, setBlockRenderer } from "../auto-reply/pi-agent-tools.js";
import { splitMediaFromOutput } from "../media/parse.js";
import { startDashboardBridge } from "../api/dashboard-bridge.js";
import { isAgentCommand, parseAgentCommand, handleAgentCommand } from "../auto-reply/agents/handler.js";
import { getAgentManager } from "../auto-reply/agents/manager.js";
import { loadConfig } from "../config/config.js";
import { loadScratchpad, saveScratchpad } from "../auto-reply/pi-agent-scratchpad.js";
import { applyFeedbackToScratchpad } from "../auto-reply/feedback.js";

const SLACK_APP_TOKEN = process.env.SLACK_APP_TOKEN || process.env.MOM_SLACK_APP_TOKEN;
const SLACK_BOT_TOKEN = process.env.SLACK_BOT_TOKEN || process.env.MOM_SLACK_BOT_TOKEN;

// Parse command line arguments
function parseArgs(): { workingDir: string } {
	const args = process.argv.slice(2);
	let workingDir: string | undefined;

	for (let i = 0; i < args.length; i++) {
		const arg = args[i];
		if (!arg.startsWith("-")) {
			workingDir = arg;
		} else {
			console.error(`Unknown option: ${arg}`);
			process.exit(1);
		}
	}

	if (!workingDir) {
		console.error("Usage: relay01 <working-directory>");
		console.error("");
		console.error("Examples:");
		console.error("  relay01 ./data");
		console.error("  relay01 ~/.relay01/data");
		process.exit(1);
	}

	return { workingDir: resolve(workingDir) };
}

const { workingDir } = parseArgs();

log.logStartup(workingDir, "host");

if (!SLACK_APP_TOKEN || !SLACK_BOT_TOKEN) {
	console.error("Missing required environment variables:");
	if (!SLACK_APP_TOKEN) console.error("  - SLACK_APP_TOKEN (xapp-...)");
	if (!SLACK_BOT_TOKEN) console.error("  - SLACK_BOT_TOKEN (xoxb-...)");
	process.exit(1);
}

// manager is initialized inside the startup IIFE after bot.start() so notifyFn has access to getSessionChannelId
let manager!: PiAgentManager;
const piTimeoutMs = Number(process.env.PI_TIMEOUT_MS) || 120000;

// Track active runs per channel to prevent concurrent executions
const activeRuns = new Set<string>();

async function handleMessage(ctx: SlackContext, source: "channel" | "dm"): Promise<void> {
	const channelId = ctx.message.channel;
	const messageText = ctx.message.text.toLowerCase().trim();

	// Session name: @username for DMs (personal context), #channelname for channels (shared context)
	// This is used for both session keying and folder paths under slack/
	// Note: ctx.channelName already includes the # prefix from slack.ts
	const sessionName = source === "dm"
		? `@${ctx.message.userName}`
		: ctx.channelName ?? `#${ctx.message.channel}`;

	const logCtx = {
		channelId: ctx.message.channel,
		userName: ctx.message.userName,
		channelName: ctx.channelName,
	};

	// Check for stop command
	if (messageText === "stop") {
		if (activeRuns.has(channelId)) {
			log.logStopRequest(logCtx);
			await ctx.respond("_Stopping..._");
			// Reset the session which will trigger summarization
			manager.resetSession(sessionName);
			activeRuns.delete(channelId);
			await ctx.replaceMessage("_Stopped_");
		} else {
			await ctx.respond("_Nothing running._");
		}
		return;
	}

	// Check for reload clicks command
	if (messageText === "reload clicks" || messageText === "clicks reload") {
		const clickScheduler = getClickScheduler();
		await ctx.respond("_Reloading clicks..._");
		await clickScheduler.reload(sessionName);
		const status = clickScheduler.getStatus().filter(s => s.key.startsWith(sessionName));
		await ctx.replaceMessage(`_Clicks reloaded. ${status.length} click(s) scheduled for this session._`);
		return;
	}

	// Check for reload all clicks command (reloads all sessions)
	if (messageText === "reload all clicks") {
		const clickScheduler = getClickScheduler();
		await ctx.respond("_Reloading all clicks..._");
		await clickScheduler.reload();
		const status = clickScheduler.getStatus();
		await ctx.replaceMessage(`_All clicks reloaded. ${status.length} click(s) scheduled across all sessions._`);
		return;
	}

	// Check for trigger click command
	if (messageText.startsWith("trigger click ")) {
		const clickId = messageText.slice("trigger click ".length).trim();
		if (!clickId) {
			await ctx.respond("_Usage: trigger click <click-id>_");
			return;
		}
		const clickScheduler = getClickScheduler();
		await ctx.respond(`_Triggering click "${clickId}"..._`);
		const result = await clickScheduler.triggerClick(sessionName, clickId);
		if (!result) {
			await ctx.replaceMessage(`_Click "${clickId}" not found for this session._`);
		} else if (result.error) {
			await ctx.replaceMessage(`_Click "${clickId}" failed: ${result.error}_`);
		} else {
			const alertStatus = result.shouldAlert ? "🚨 ALERT" : "✓ OK";
			const body = result.details.trim() || result.summary;
			await ctx.replaceMessage(`_Click "${clickId}" completed: ${alertStatus}_\n\n${body}`);
		}
		return;
	}

	// Check for events status command
	if (messageText === "events" || messageText === "list events") {
		const eventsWatcher = getEventsWatcher();
		const status = eventsWatcher.getStatus().filter(s => s.sessionName === sessionName);
		if (status.length === 0) {
			await ctx.respond("_No active events for this session._");
		} else {
			const list = status.map(s => `• \`${s.key}\` (${s.type})`).join("\n");
			await ctx.respond(`*Active events:*\n${list}`);
		}
		return;
	}

	// Check for trigger event command
	if (messageText.startsWith("trigger event ")) {
		const filename = messageText.slice("trigger event ".length).trim();
		if (!filename) {
			await ctx.respond("_Usage: trigger event <filename.json>_");
			return;
		}
		const eventsWatcher = getEventsWatcher();
		await ctx.respond(`_Triggering event "${filename}"..._`);
		const result = await eventsWatcher.triggerEvent(sessionName, filename.endsWith(".json") ? filename : `${filename}.json`);
		if (!result) {
			await ctx.replaceMessage(`_Event "${filename}" not found._`);
		} else if (result.error) {
			await ctx.replaceMessage(`_Event "${filename}" failed: ${result.error}_`);
		} else {
			const status = result.silent ? "(silent)" : "✓";
			await ctx.replaceMessage(`_Event "${filename}" completed ${status}_`);
		}
		return;
	}

	// Check for agent commands
	if (isAgentCommand(messageText)) {
		const cmd = parseAgentCommand(messageText);
		if (cmd) {
			const response = await handleAgentCommand(cmd, sessionName, async (msg) => {
				await ctx.respond(msg);
			});
			if (response) await ctx.respond(response);
			return;
		}
	}

	// Check if already running in this channel
	if (activeRuns.has(channelId)) {
		await ctx.respond("_Already working on something. Say `stop` to cancel._");
		return;
	}

	log.logUserMessage(logCtx, ctx.message.text);
	activeRuns.add(channelId);

	await ctx.setTyping(true);
	await ctx.setWorking(true);

	// Set up the upload function for the attach tool (keyed by session so
	// concurrent channels/DMs don't stomp each other's closures).
	setUploadFunction(sessionName, ctx.uploadFile);
	// Set up the Block Kit renderer for the render_ui tool
	setBlockRenderer(sessionName, ctx.respondBlocks);

	try {
		// Build message with attachment info if present
		let messageText = ctx.message.text;
		if (ctx.message.attachments.length > 0) {
			const attachmentList = ctx.message.attachments
				.map((a) => `- ${a.original} → ${a.local}`)
				.join("\n");
			messageText += `\n\n[Attachments downloaded to scratchpad/attachments/]\n${attachmentList}`;
		}

		// Use Pi Agent Manager to get response
		// sessionName determines context isolation: @username for DMs, #channelname for channels
		const steps: Step[] = [];
		const result = await manager.prompt(sessionName, messageText, {
			timeoutMs: piTimeoutMs,
			// Slack user ID — stable key for user-scoped memory (DMs only)
			userId: source === "dm" ? ctx.message.user : undefined,
			onToolActivity: async (e: ToolActivity) => {
				if (e.phase === "start") {
					steps.push({ label: e.label, state: "run" });
				} else {
					const s = [...steps].reverse().find((x) => x.label === e.label && x.state === "run");
					if (s) s.state = e.isError ? "err" : "ok";
				}
				await ctx.replaceMessage(renderStepChecklist(steps));
			},
		});

		// Parse MEDIA: tokens from response
		const { text: cleanedText, mediaUrls } = splitMediaFromOutput(result.text || "");

		// Send text response to Slack.
		// If render_ui already posted a Block Kit card and the agent produced no
		// trailing text, leave the card in place instead of clobbering it with a
		// "(No response from agent)" text-only update.
		if (cleanedText) {
			await ctx.respond(cleanedText);
		} else if (!mediaUrls?.length && !ctx.hasRenderedBlocks()) {
			await ctx.respond("_(No response from agent)_");
		}

		// Upload any media files referenced in MEDIA: tokens
		if (mediaUrls?.length) {
			for (const mediaPath of mediaUrls) {
				try {
					await ctx.uploadFile(mediaPath);
					log.logResponse(logCtx, `[Uploaded media: ${mediaPath}]`);
				} catch (err) {
					log.logAgentError(logCtx, `Failed to upload media ${mediaPath}: ${err}`);
				}
			}
		}

		log.logResponse(logCtx, cleanedText || "(empty)");
	} catch (err) {
		log.logAgentError(logCtx, String(err));
		await ctx.respond(`_Error: ${String(err)}_`);
	} finally {
		setUploadFunction(sessionName, null); // Clear upload function for this session
		setBlockRenderer(sessionName, null); // Clear block renderer so stale closures can't leak across sessions
		await ctx.setWorking(false);
		activeRuns.delete(channelId);
	}
}

async function onFeedback({ sessionName, positive, text, wasBot }: FeedbackEvent) {
	// Only record feedback for reactions on the bot's own messages. A 👍/👎 on
	// another user's message says nothing about the bot's responses.
	if (!wasBot) return;
	const existing = (await loadScratchpad(sessionName)) ?? { summary: [], critical: [], recentTurns: [] };
	await saveScratchpad(sessionName, applyFeedbackToScratchpad(existing, positive, text));
}

const bot = new MomBot(
	{
		async onChannelMention(ctx) {
			await handleMessage(ctx, "channel");
		},

		async onDirectMessage(ctx) {
			await handleMessage(ctx, "dm");
		},
	},
	{
		appToken: SLACK_APP_TOKEN,
		botToken: SLACK_BOT_TOKEN,
		workingDir,
		onFeedback,
		onBlockAction: async (e: BlockActionEvent) => {
			await getApprovalManager().handleAction(e.actionId, e.userName);
		},
	},
);

// Initialize skills system, start bot, and initialize click scheduler
(async () => {
	await initializeSkills();
	await bot.start();

	// Helper to resolve session name to channel ID
	const getSessionChannelId = async (sessionName: string) => {
		// Convert @username to DM channel ID
		if (sessionName.startsWith("@")) {
			const userName = sessionName.slice(1);
			return bot.getOrCreateDmChannel(userName);
		}
		// Convert #channel to channel ID
		if (sessionName.startsWith("#")) {
			const channelName = sessionName.slice(1);
			return bot.getChannelByName(channelName);
		}
		return undefined;
	};

	// Initialize Pi Agent Manager with config and notifyFn
	// Model defaults are set in ~/relay01/slack/.env (global) or per-session .env files
	const piAgentConfig: PiAgentConfig = {
		model: process.env.PI_AGENT_MODEL,  // Falls back to DEFAULT_MODEL in pi-agent.ts if not set
		thinkingLevel: (process.env.PI_THINKING_LEVEL as PiAgentConfig["thinkingLevel"]) || "off",
		timeoutMs: Number(process.env.PI_TIMEOUT_MS) || 120000,
		notifyFn: async (session: string, message: string) => {
			const channelId = await getSessionChannelId(session);
			if (channelId) {
				await bot.getWebClient().chat.postMessage({ channel: channelId, text: message });
			}
		},
		webClient: bot.getWebClient(),
		channelIdFn: getSessionChannelId,
	};
	console.log(`[config] Model: ${piAgentConfig.model}, Thinking: ${piAgentConfig.thinkingLevel}, Timeout: ${piAgentConfig.timeoutMs}ms`);
	manager = getPiAgentManager(piAgentConfig, 720);

	// Initialize agent manager with Slack notification callback
	const agentsCfg = loadConfig().agents;
	getAgentManager({
		definitionsPath: agentsCfg?.definitionsPath ?? "~/relay01/agents/definitions",
		maxConcurrent: agentsCfg?.maxConcurrent ?? 3,
		sendNotification: async (session: string, message: string) => {
			const channelId = await getSessionChannelId(session);
			if (channelId) {
				await bot.getWebClient().chat.postMessage({ channel: channelId, text: message });
			}
		},
	});
	// Resume any runs that were active before restart
	await getAgentManager().resumeActiveRuns();

	// Configure the write-approval gate (gates tool calls per approvals.json)
	getApprovalManager().configure({
		webClient: bot.getWebClient(),
		getSessionChannelId,
	});

	// Initialize click scheduler for proactive polling
	const clickScheduler = getClickScheduler();
	await clickScheduler.start({
		webClient: bot.getWebClient(),
		getChannelByName: (name) => bot.getChannelByName(name),
		getSessionChannelId,
	});

	// Initialize events watcher for session agent wakeups
	const eventsWatcher = getEventsWatcher();
	await eventsWatcher.start({
		webClient: bot.getWebClient(),
		getSessionChannelId,
	});

	// Start dashboard bridge API
	const bridgePort = Number(process.env.DASHBOARD_BRIDGE_PORT) || 3456;
	startDashboardBridge(bridgePort);
})();
