import { SocketModeClient } from "@slack/socket-mode";
import { type ConversationsHistoryResponse, WebClient } from "@slack/web-api";
import { readFileSync } from "fs";
import { basename } from "path";
import * as log from "./log.js";
import { splitSlackText } from "./split-message.js";
import { type Attachment, ChannelStore } from "./store.js";

export interface SlackMessage {
	text: string; // message content (mentions stripped)
	rawText: string; // original text with mentions
	user: string; // user ID
	userName?: string; // user handle
	channel: string; // channel ID
	ts: string; // timestamp (for threading)
	attachments: Attachment[]; // file attachments
}

export interface SlackContext {
	message: SlackMessage;
	channelName?: string; // channel name for logging (e.g., #dev-team)
	store: ChannelStore;
	/** All channels the bot is a member of */
	channels: ChannelInfo[];
	/** All known users in the workspace */
	users: UserInfo[];
	/** Send/update the main message (accumulates text). Set log=false to skip logging. */
	respond(text: string, log?: boolean): Promise<void>;
	/** Replace the entire message text (not append) */
	replaceMessage(text: string): Promise<void>;
	/** Post/update the main message as Block Kit. `text` is the notification fallback. */
	respondBlocks(blocks: unknown[], text: string): Promise<void>;
	/** True once respondBlocks has rendered a Block Kit card (the final UI). */
	hasRenderedBlocks(): boolean;
	/** Post a message in the thread under the main message (for verbose details) */
	respondInThread(text: string): Promise<void>;
	/** Show/hide typing indicator */
	setTyping(isTyping: boolean): Promise<void>;
	/** Upload a file to the channel */
	uploadFile(filePath: string, title?: string): Promise<void>;
	/** Set working state (adds/removes working indicator emoji) */
	setWorking(working: boolean): Promise<void>;
}

export interface MomHandler {
	onChannelMention(ctx: SlackContext): Promise<void>;
	onDirectMessage(ctx: SlackContext): Promise<void>;
}

export type FeedbackEvent = { sessionName: string; positive: boolean; text: string; wasBot: boolean };
export type OnFeedback = (e: FeedbackEvent) => Promise<void>;

export type SlashCommandEvent = {
	command: string; // e.g. "/relay"
	text: string; // everything after the command
	userId: string;
	userName: string;
	channelId: string;
	channelName: string; // without #; "directmessage" for DMs
};
/** Reply to a slash command (ephemeral by default; inChannel=true posts publicly). */
export type SlashRespond = (text: string, inChannel?: boolean) => Promise<void>;
export type OnSlashCommand = (e: SlashCommandEvent, respond: SlashRespond) => Promise<void>;

export type BlockActionEvent = {
	actionId: string;
	userId: string;
	userName: string; // display name, e.g. @handle
	channel?: string;
	messageTs?: string;
};
export type OnBlockAction = (e: BlockActionEvent) => Promise<void>;

export interface MomBotConfig {
	appToken: string;
	botToken: string;
	workingDir: string; // directory for channel data and attachments
	onFeedback?: OnFeedback;
	onBlockAction?: OnBlockAction;
	onSlashCommand?: OnSlashCommand;
}

export interface ChannelInfo {
	id: string;
	name: string;
}

export interface UserInfo {
	id: string;
	userName: string;
	displayName: string;
}

export class MomBot {
	private socketClient: SocketModeClient;
	private webClient: WebClient;
	private handler: MomHandler;
	private botUserId: string | null = null;
	public readonly store: ChannelStore;
	private userCache: Map<string, { userName: string; displayName: string }> = new Map();
	private channelCache: Map<string, string> = new Map(); // id -> name
	// Threads the bot participates in: replies here trigger it without a
	// re-mention (OpenTag-style thread subscription). Key `${channel}:${threadTs}`
	// → subscription time, pruned after SUBSCRIPTION_TTL_MS. In-memory only.
	private subscribedThreads: Map<string, number> = new Map();
	private static readonly SUBSCRIPTION_TTL_MS = 24 * 60 * 60 * 1000;
	private static readonly MAX_SUBSCRIPTIONS = 500;
	private onFeedback?: OnFeedback;
	private onBlockAction?: OnBlockAction;
	private onSlashCommand?: OnSlashCommand;

	constructor(handler: MomHandler, config: MomBotConfig) {
		this.handler = handler;
		this.onFeedback = config.onFeedback;
		this.onBlockAction = config.onBlockAction;
		this.onSlashCommand = config.onSlashCommand;
		this.socketClient = new SocketModeClient({ appToken: config.appToken });
		this.webClient = new WebClient(config.botToken);
		this.store = new ChannelStore({
			workingDir: config.workingDir,
			botToken: config.botToken,
		});

		this.setupEventHandlers();
	}

	/**
	 * Fetch all channels the bot is a member of
	 */
	private async fetchChannels(): Promise<void> {
		try {
			let cursor: string | undefined;
			do {
				const result = await this.webClient.conversations.list({
					types: "public_channel,private_channel",
					exclude_archived: true,
					limit: 200,
					cursor,
				});

				const channels = result.channels as Array<{ id?: string; name?: string; is_member?: boolean }> | undefined;
				if (channels) {
					for (const channel of channels) {
						if (channel.id && channel.name && channel.is_member) {
							this.channelCache.set(channel.id, channel.name);
						}
					}
				}

				cursor = result.response_metadata?.next_cursor;
			} while (cursor);
		} catch (error) {
			log.logWarning("Failed to fetch channels", String(error));
		}
	}

	/**
	 * Fetch all workspace users
	 */
	private async fetchUsers(): Promise<void> {
		try {
			let cursor: string | undefined;
			do {
				const result = await this.webClient.users.list({
					limit: 200,
					cursor,
				});

				const members = result.members as
					| Array<{ id?: string; name?: string; real_name?: string; deleted?: boolean }>
					| undefined;
				if (members) {
					for (const user of members) {
						if (user.id && user.name && !user.deleted) {
							this.userCache.set(user.id, {
								userName: user.name,
								displayName: user.real_name || user.name,
							});
						}
					}
				}

				cursor = result.response_metadata?.next_cursor;
			} while (cursor);
		} catch (error) {
			log.logWarning("Failed to fetch users", String(error));
		}
	}

	/**
	 * Get all known channels (id -> name)
	 */
	getChannels(): ChannelInfo[] {
		return Array.from(this.channelCache.entries()).map(([id, name]) => ({ id, name }));
	}

	/**
	 * Get all known users
	 */
	getUsers(): UserInfo[] {
		return Array.from(this.userCache.entries()).map(([id, { userName, displayName }]) => ({
			id,
			userName,
			displayName,
		}));
	}

	/**
	 * Get the WebClient instance for direct API calls.
	 */
	getWebClient(): WebClient {
		return this.webClient;
	}

	/**
	 * Get channel ID by name (without # prefix).
	 */
	getChannelByName(name: string): string | undefined {
		for (const [id, channelName] of this.channelCache) {
			if (channelName === name) {
				return id;
			}
		}
		return undefined;
	}

	/**
	 * Get or create a DM channel with a user by username.
	 */
	async getOrCreateDmChannel(userName: string): Promise<string | undefined> {
		// Find user ID from username
		let userId: string | undefined;
		for (const [id, info] of this.userCache) {
			if (info.userName === userName) {
				userId = id;
				break;
			}
		}

		if (!userId) {
			return undefined;
		}

		try {
			const result = await this.webClient.conversations.open({
				users: userId,
			});
			return result.channel?.id;
		} catch {
			return undefined;
		}
	}

	/**
	 * Obfuscate usernames and user IDs in text to prevent pinging people
	 * e.g., "nate" -> "n_a_t_e", "@mario" -> "@m_a_r_i_o", "<@U123>" -> "<@U_1_2_3>"
	 */
	private obfuscateUsernames(text: string): string {
		let result = text;

		// Obfuscate user IDs like <@U16LAL8LS>
		result = result.replace(/<@([A-Z0-9]+)>/gi, (_match, id) => {
			return `<@${id.split("").join("_")}>`;
		});

		// Obfuscate usernames
		for (const { userName } of this.userCache.values()) {
			// Escape special regex characters in username
			const escaped = userName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
			// Match @username, <@username>, or bare username (case insensitive, word boundary)
			const pattern = new RegExp(`(<@|@)?(\\b${escaped}\\b)`, "gi");
			result = result.replace(pattern, (_match, prefix, name) => {
				const obfuscated = name.split("").join("_");
				return (prefix || "") + obfuscated;
			});
		}
		return result;
	}

	/**
	 * Resolve a channel ID to its name (without # prefix), mirroring createContext:
	 * use the cache, otherwise do a live conversations.info lookup and populate the
	 * cache. Falls back to the raw channel ID on lookup failure.
	 */
	private async resolveChannelName(channelId: string): Promise<string> {
		const cached = this.channelCache.get(channelId);
		if (cached) return cached;
		try {
			const result = await this.webClient.conversations.info({ channel: channelId });
			const name = result.channel?.name;
			if (name) {
				this.channelCache.set(channelId, name);
				return name;
			}
		} catch {
			// fall through to raw ID
		}
		return channelId;
	}

	private async getUserInfo(userId: string): Promise<{ userName: string; displayName: string }> {
		if (this.userCache.has(userId)) {
			return this.userCache.get(userId)!;
		}

		try {
			const result = await this.webClient.users.info({ user: userId });
			const user = result.user as { name?: string; real_name?: string };
			const info = {
				userName: user?.name || userId,
				displayName: user?.real_name || user?.name || userId,
			};
			this.userCache.set(userId, info);
			return info;
		} catch {
			return { userName: userId, displayName: userId };
		}
	}

	/** Subscribe the bot to a thread so unmentioned replies there trigger it. */
	private subscribeThread(channel: string, threadTs: string): void {
		const now = Date.now();
		// Prune expired entries, and the oldest when at capacity
		for (const [key, at] of this.subscribedThreads) {
			if (now - at > MomBot.SUBSCRIPTION_TTL_MS) this.subscribedThreads.delete(key);
		}
		if (this.subscribedThreads.size >= MomBot.MAX_SUBSCRIPTIONS) {
			const oldest = this.subscribedThreads.keys().next().value;
			if (oldest) this.subscribedThreads.delete(oldest);
		}
		this.subscribedThreads.set(`${channel}:${threadTs}`, now);
	}

	private isSubscribedThread(channel: string, threadTs?: string): boolean {
		if (!threadTs) return false;
		const at = this.subscribedThreads.get(`${channel}:${threadTs}`);
		return at !== undefined && Date.now() - at <= MomBot.SUBSCRIPTION_TTL_MS;
	}

	private setupEventHandlers(): void {
		// Handle @mentions in channels
		this.socketClient.on("app_mention", async ({ event, ack }) => {
			await ack();

			const slackEvent = event as {
				text: string;
				channel: string;
				user: string;
				ts: string;
				thread_ts?: string;
				files?: Array<{ name: string; url_private_download?: string; url_private?: string }>;
			};

			// Log the mention message (message event may not fire for all channel types)
			await this.logMessage({
				text: slackEvent.text,
				channel: slackEvent.channel,
				user: slackEvent.user,
				ts: slackEvent.ts,
				files: slackEvent.files,
			});

			// Once mentioned in a thread, follow the rest of that thread
			this.subscribeThread(slackEvent.channel, slackEvent.thread_ts ?? slackEvent.ts);

			const ctx = await this.createContext(slackEvent, "channel");
			await this.handler.onChannelMention(ctx);
		});

		// Handle all messages (for logging) and DMs (for triggering handler)
		this.socketClient.on("message", async ({ event, ack }) => {
			await ack();

			const slackEvent = event as {
				text?: string;
				channel: string;
				user?: string;
				ts: string;
				thread_ts?: string;
				channel_type?: string;
				subtype?: string;
				bot_id?: string;
				files?: Array<{ name: string; url_private_download?: string; url_private?: string }>;
			};

			// Ignore bot messages
			if (slackEvent.bot_id) return;
			// Ignore message edits, etc. (but allow file_share)
			if (slackEvent.subtype !== undefined && slackEvent.subtype !== "file_share") return;
			// Ignore if no user
			if (!slackEvent.user) return;
			// Ignore messages from the bot itself
			if (slackEvent.user === this.botUserId) return;
			// Ignore if no text AND no files
			if (!slackEvent.text && (!slackEvent.files || slackEvent.files.length === 0)) return;

			// Log ALL messages (channel and DM)
			await this.logMessage({
				text: slackEvent.text || "",
				channel: slackEvent.channel,
				user: slackEvent.user,
				ts: slackEvent.ts,
				files: slackEvent.files,
			});

			// Only trigger handler for DMs (channel mentions are handled by app_mention event)
			if (slackEvent.channel_type === "im") {
				const ctx = await this.createContext({
					text: slackEvent.text || "",
					channel: slackEvent.channel,
					user: slackEvent.user,
					ts: slackEvent.ts,
					files: slackEvent.files,
				}, "dm");
				await this.handler.onDirectMessage(ctx);
				return;
			}

			// Thread subscription: unmentioned replies in a thread the bot
			// participates in trigger it like a mention. Mentions themselves are
			// skipped here — the app_mention event already handles them.
			const mentionsBot = !!this.botUserId && (slackEvent.text ?? "").includes(`<@${this.botUserId}>`);
			if (!mentionsBot && this.isSubscribedThread(slackEvent.channel, slackEvent.thread_ts)) {
				const ctx = await this.createContext({
					text: slackEvent.text || "",
					channel: slackEvent.channel,
					user: slackEvent.user,
					ts: slackEvent.ts,
					thread_ts: slackEvent.thread_ts,
					files: slackEvent.files,
				}, "channel");
				await this.handler.onChannelMention(ctx);
			}
		});

		// Handle slash commands (e.g. /relay status). Ack within 3s, then reply
		// asynchronously via response_url (valid for 30 min), so slow
		// subcommands like click runs don't hit the ack deadline.
		this.socketClient.on("slash_commands", async ({ body, ack }) => {
			await ack();
			const e = body as {
				command?: string;
				text?: string;
				user_id?: string;
				user_name?: string;
				channel_id?: string;
				channel_name?: string;
				response_url?: string;
			};
			if (!this.onSlashCommand || !e.command || !e.response_url) return;
			const responseUrl = e.response_url;
			const respond: SlashRespond = async (text: string, inChannel = false) => {
				await fetch(responseUrl, {
					method: "POST",
					headers: { "Content-Type": "application/json" },
					body: JSON.stringify({ response_type: inChannel ? "in_channel" : "ephemeral", text }),
				});
			};
			try {
				await this.onSlashCommand(
					{
						command: e.command,
						text: (e.text ?? "").trim(),
						userId: e.user_id ?? "",
						userName: e.user_name ?? "",
						channelId: e.channel_id ?? "",
						channelName: e.channel_name ?? "",
					},
					respond,
				);
			} catch (error) {
				log.logWarning("Slash command handler failed", String(error));
				await respond(`Error: ${String(error)}`).catch(() => {});
			}
		});

		// Handle interactive block actions (e.g. approval buttons)
		this.socketClient.on("interactive", async ({ body, ack }) => {
			await ack();
			const payload = body as {
				type?: string;
				user?: { id?: string; username?: string; name?: string };
				actions?: Array<{ action_id?: string }>;
				channel?: { id?: string };
				message?: { ts?: string };
			};
			if (payload.type !== "block_actions" || !this.onBlockAction) return;
			const userId = payload.user?.id ?? "";
			const userName = payload.user?.username || payload.user?.name || userId;
			for (const action of payload.actions ?? []) {
				if (!action.action_id) continue;
				try {
					await this.onBlockAction({
						actionId: action.action_id,
						userId,
						userName: userName.startsWith("@") ? userName : `@${userName}`,
						channel: payload.channel?.id,
						messageTs: payload.message?.ts,
					});
				} catch (error) {
					log.logWarning("Block action handler failed", String(error));
				}
			}
		});

		// Handle 👍/👎 reactions as feedback for continuous learning
		this.socketClient.on("reaction_added", async ({ event, ack }) => {
			await ack();
			const e = event as {
				reaction: string;
				user: string;
				item: { type: string; channel: string; ts: string };
			};
			if (!["+1", "-1"].includes(e.reaction)) return;
			if (e.user === this.botUserId || e.item.type !== "message") return;

			const isDm = e.item.channel.startsWith("D");
			const sessionName = isDm
				? "@" + (await this.getUserInfo(e.user)).userName
				: "#" + (await this.resolveChannelName(e.item.channel));

			let reactedText = "";
			let wasBot = false;
			try {
				const hist = await this.webClient.conversations.history({
					channel: e.item.channel,
					latest: e.item.ts,
					inclusive: true,
					limit: 1,
				});
				let msg = hist.messages?.[0] as { ts?: string; text?: string; user?: string } | undefined;
				// conversations.history only returns top-level messages. If the
				// reacted message is a thread reply, history returns the nearest
				// channel message instead — detect the ts mismatch and fetch the
				// exact message via conversations.replies.
				if (!msg || msg.ts !== e.item.ts) {
					const replies = await this.webClient.conversations.replies({
						channel: e.item.channel,
						ts: e.item.ts,
						latest: e.item.ts,
						inclusive: true,
						limit: 1,
					});
					const reply = replies.messages?.[0] as { ts?: string; text?: string; user?: string } | undefined;
					if (reply?.ts === e.item.ts) msg = reply;
				}
				reactedText = msg?.text ?? "";
				wasBot = msg?.user === this.botUserId;
			} catch {
				/* best effort */
			}

			await this.onFeedback?.({ sessionName, positive: e.reaction === "+1", text: reactedText, wasBot });
		});
	}

	private async logMessage(event: {
		text: string;
		channel: string;
		user: string;
		ts: string;
		files?: Array<{ name: string; url_private_download?: string; url_private?: string }>;
	}): Promise<void> {
		// For logging, we don't download attachments - just record metadata
		const attachments = event.files ? event.files.filter(f => f.name).map(f => ({
			original: f.name!,
			local: "", // Not downloaded for logging
		})) : [];
		const { userName, displayName } = await this.getUserInfo(event.user);

		await this.store.logMessage(event.channel, {
			date: new Date(parseFloat(event.ts) * 1000).toISOString(),
			ts: event.ts,
			user: event.user,
			userName,
			displayName,
			text: event.text,
			attachments,
			isBot: false,
		});
	}

	private async createContext(event: {
		text: string;
		channel: string;
		user: string;
		ts: string;
		thread_ts?: string;
		files?: Array<{ name: string; url_private_download?: string; url_private?: string }>;
	}, source: "channel" | "dm"): Promise<SlackContext> {
		// When the trigger came from inside a thread, respond in that thread.
		const replyThreadTs = source === "channel" ? event.thread_ts : undefined;
		const rawText = event.text;
		const text = rawText.replace(/<@[A-Z0-9]+>/gi, "").trim();

		// Get user info for logging
		const { userName } = await this.getUserInfo(event.user);

		// Get channel name for logging (best effort)
		let channelName: string | undefined;
		try {
			if (event.channel.startsWith("C")) {
				const result = await this.webClient.conversations.info({ channel: event.channel });
				if (result.channel?.name) {
					channelName = `#${result.channel.name}`;
					// Add to channel cache so clicks can resolve this channel
					if (!this.channelCache.has(event.channel)) {
						this.channelCache.set(event.channel, result.channel.name);
						log.logInfo(`Added channel to cache: ${channelName}`);
					}
				}
			}
		} catch {
			// Ignore errors - we'll just use the channel ID
		}

		// Compute session name for attachment downloads
		// DMs use @username, channels use #channelname (channelName already includes #)
		const sessionName = source === "dm"
			? `@${userName}`
			: channelName ?? `#${event.channel}`;

		// Process attachments - download to session scratchpad
		const attachments = event.files ? this.store.processAttachments(sessionName, event.files, event.ts) : [];

		// Track the single message for this run
		let messageTs: string | null = null;
		let accumulatedText = "";
		let isThinking = true; // Track if we're still in "thinking" state
		let isWorking = true; // Track if still processing
		const workingIndicator = " ...";
		let updatePromise: Promise<void> = Promise.resolve();

		// Block Kit state: once render_ui posts a card, every subsequent text-only
		// chat.update would drop the `blocks` (chat.update is a full replace, not a
		// merge). We re-send the stored blocks on later updates so the card survives.
		let hasRenderedBlocks = false;
		let lastBlocks: unknown[] | null = null;
		let overflowPostedCount = 0;
		// Build chat.update args, preserving the rendered Block Kit card if present.
		const buildUpdate = (displayText: string) =>
			hasRenderedBlocks && lastBlocks
				? { channel: event.channel, ts: messageTs!, text: displayText, blocks: lastBlocks as any }
				: { channel: event.channel, ts: messageTs!, text: displayText };

		// Post/update the first chunk on the main message; overflow goes in thread replies.
		const deliverText = async (text: string, opts?: { blocks?: unknown[] | null }): Promise<void> => {
			const chunks = splitSlackText(text);

			if (messageTs) {
				if (opts?.blocks) {
					await this.webClient.chat.update({
						channel: event.channel,
						ts: messageTs,
						text: chunks[0],
						blocks: opts.blocks as any,
					});
				} else {
					await this.webClient.chat.update(buildUpdate(chunks[0]));
				}
			} else {
				const result = await this.webClient.chat.postMessage({
					channel: event.channel,
					text: chunks[0],
					...(replyThreadTs ? { thread_ts: replyThreadTs } : {}),
					...(opts?.blocks ? { blocks: opts.blocks as any } : {}),
				});
				messageTs = result.ts as string;
				// Follow replies to the bot's own top-level responses in channels
				if (source === "channel" && !replyThreadTs && messageTs) {
					this.subscribeThread(event.channel, messageTs);
				}
			}

			const neededOverflow = chunks.length - 1;
			while (overflowPostedCount < neededOverflow) {
				overflowPostedCount++;
				await this.webClient.chat.postMessage({
					channel: event.channel,
					thread_ts: messageTs!,
					text: chunks[overflowPostedCount],
				});
			}
		};

		return {
			message: {
				text,
				rawText,
				user: event.user,
				userName,
				channel: event.channel,
				ts: event.ts,
				attachments,
			},
			channelName,
			store: this.store,
			channels: this.getChannels(),
			users: this.getUsers(),
			respond: async (responseText: string, log = true) => {
				// Queue updates to avoid race conditions
				updatePromise = updatePromise.then(async () => {
					if (isThinking) {
						// First real response replaces "Thinking..."
						accumulatedText = responseText;
						isThinking = false;
					} else {
						// Subsequent responses get appended
						accumulatedText += "\n" + responseText;
					}

					// Add working indicator if still working
					const displayText = isWorking ? accumulatedText + workingIndicator : accumulatedText;
					await deliverText(displayText);

					// Log the response if requested
					if (log) {
						await this.store.logBotResponse(event.channel, responseText, messageTs!);
					}
				});

				await updatePromise;
			},
			respondInThread: async (threadText: string) => {
				// Queue thread posts to maintain order
				updatePromise = updatePromise.then(async () => {
					if (!messageTs) {
						// No main message yet, just skip
						return;
					}
					// Obfuscate usernames to avoid pinging people in thread details
					const obfuscatedText = this.obfuscateUsernames(threadText);
					for (const chunk of splitSlackText(obfuscatedText)) {
						await this.webClient.chat.postMessage({
							channel: event.channel,
							thread_ts: messageTs,
							text: chunk,
						});
					}
				});
				await updatePromise;
			},
			setTyping: async (isTyping: boolean) => {
				if (isTyping && !messageTs) {
					// Post initial "thinking" message (... auto-appended by working indicator)
					accumulatedText = "_Thinking_";
					const result = await this.webClient.chat.postMessage({
						channel: event.channel,
						text: accumulatedText,
						...(replyThreadTs ? { thread_ts: replyThreadTs } : {}),
					});
					messageTs = result.ts as string;
					if (source === "channel" && !replyThreadTs && messageTs) {
						this.subscribeThread(event.channel, messageTs);
					}
				}
				// We don't delete/clear anymore - message persists and gets updated
			},
			uploadFile: async (filePath: string, title?: string) => {
				const fileName = title || basename(filePath);
				const fileContent = readFileSync(filePath);

				await this.webClient.files.uploadV2({
					channel_id: event.channel,
					file: fileContent,
					filename: fileName,
					title: fileName,
				});
			},
			replaceMessage: async (text: string) => {
				updatePromise = updatePromise.then(async () => {
					// Replace the accumulated text entirely
					accumulatedText = text;

					const displayText = isWorking ? accumulatedText + workingIndicator : accumulatedText;
					await deliverText(displayText);
				});
				await updatePromise;
			},
			respondBlocks: async (blocks: unknown[], fallback: string) => {
				updatePromise = updatePromise.then(async () => {
					isThinking = false;
					hasRenderedBlocks = true;
					lastBlocks = blocks;
					// Keep accumulatedText in sync with the fallback so a later text
					// update doesn't prepend stale step-checklist text.
					accumulatedText = fallback;
					await deliverText(fallback, { blocks });
					await this.store.logBotResponse(event.channel, fallback, messageTs!);
				});
				await updatePromise;
			},
			hasRenderedBlocks: () => hasRenderedBlocks,
			setWorking: async (working: boolean) => {
				updatePromise = updatePromise.then(async () => {
					isWorking = working;

					// If we have a message, update it to add/remove indicator
					if (messageTs) {
						const displayText = isWorking ? accumulatedText + workingIndicator : accumulatedText;
						await deliverText(displayText);
					}
				});
				await updatePromise;
			},
		};
	}

	/**
	 * Backfill missed messages for a single channel
	 * Returns the number of messages backfilled
	 */
	private async backfillChannel(channelId: string): Promise<number> {
		const lastTs = this.store.getLastTimestamp(channelId);

		// Collect messages from up to 3 pages
		type Message = NonNullable<ConversationsHistoryResponse["messages"]>[number];
		const allMessages: Message[] = [];

		let cursor: string | undefined;
		let pageCount = 0;
		const maxPages = 3;

		do {
			const result = await this.webClient.conversations.history({
				channel: channelId,
				oldest: lastTs ?? undefined,
				inclusive: false,
				limit: 1000,
				cursor,
			});

			if (result.messages) {
				allMessages.push(...result.messages);
			}

			cursor = result.response_metadata?.next_cursor;
			pageCount++;
		} while (cursor && pageCount < maxPages);

		// Filter messages: include mom's messages, exclude other bots
		const relevantMessages = allMessages.filter((msg) => {
			// Always include mom's own messages
			if (msg.user === this.botUserId) return true;
			// Exclude other bot messages
			if (msg.bot_id) return false;
			// Standard filters for user messages
			if (msg.subtype !== undefined && msg.subtype !== "file_share") return false;
			if (!msg.user) return false;
			if (!msg.text && (!msg.files || msg.files.length === 0)) return false;
			return true;
		});

		// Reverse to chronological order (API returns newest first)
		relevantMessages.reverse();

		// Log each message
		for (const msg of relevantMessages) {
			const isMomMessage = msg.user === this.botUserId;
			// For backfill logging, don't download attachments - just record metadata
			const attachments = msg.files ? msg.files.filter((f): f is { name: string } => !!f.name).map(f => ({
				original: f.name,
				local: "", // Not downloaded for backfill
			})) : [];

			if (isMomMessage) {
				// Log mom's message as bot response
				await this.store.logMessage(channelId, {
					date: new Date(parseFloat(msg.ts!) * 1000).toISOString(),
					ts: msg.ts!,
					user: "bot",
					text: msg.text || "",
					attachments,
					isBot: true,
				});
			} else {
				// Log user message
				const { userName, displayName } = await this.getUserInfo(msg.user!);
				await this.store.logMessage(channelId, {
					date: new Date(parseFloat(msg.ts!) * 1000).toISOString(),
					ts: msg.ts!,
					user: msg.user!,
					userName,
					displayName,
					text: msg.text || "",
					attachments,
					isBot: false,
				});
			}
		}

		return relevantMessages.length;
	}

	/**
	 * Backfill missed messages for all channels
	 */
	private async backfillAllChannels(): Promise<void> {
		const startTime = Date.now();
		log.logBackfillStart(this.channelCache.size);

		let totalMessages = 0;

		for (const [channelId, channelName] of this.channelCache) {
			try {
				const count = await this.backfillChannel(channelId);
				if (count > 0) {
					log.logBackfillChannel(channelName, count);
				}
				totalMessages += count;
			} catch (error) {
				log.logWarning(`Failed to backfill channel #${channelName}`, String(error));
			}
		}

		const durationMs = Date.now() - startTime;
		log.logBackfillComplete(totalMessages, durationMs);
	}

	async start(): Promise<void> {
		const auth = await this.webClient.auth.test();
		this.botUserId = auth.user_id as string;

		// Fetch channels and users in parallel
		await Promise.all([this.fetchChannels(), this.fetchUsers()]);
		log.logInfo(`Loaded ${this.channelCache.size} channels, ${this.userCache.size} users`);

		// Backfill any messages missed while offline
		await this.backfillAllChannels();

		await this.socketClient.start();
		log.logConnected();
	}

	async stop(): Promise<void> {
		await this.socketClient.disconnect();
		log.logDisconnected();
	}
}
