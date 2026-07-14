/**
 * Dashboard bridge - thin HTTP API for the relay01 dashboard to control the bot.
 * Binds to localhost only for security.
 */

import express from "express";
import { getClickScheduler } from "../auto-reply/clicks/index.js";
import { getEventsWatcher } from "../auto-reply/events/index.js";
import { onAgentEvent } from "./agent-events.js";

const startTime = Date.now();

export function startDashboardBridge(port: number = 3456) {
	const app = express();
	app.use(express.json());

	// GET /status - Runtime state
	app.get("/status", (_req, res) => {
		const clickScheduler = getClickScheduler();
		const eventsWatcher = getEventsWatcher();

		res.json({
			uptime: Math.floor((Date.now() - startTime) / 1000),
			memory: {
				rss: process.memoryUsage.rss(),
				heapUsed: process.memoryUsage().heapUsed,
				heapTotal: process.memoryUsage().heapTotal,
			},
			clickScheduler: {
				scheduled: clickScheduler.getStatus().length,
				status: clickScheduler.getStatus(),
			},
			eventsWatcher: {
				active: eventsWatcher.getStatus().length,
				status: eventsWatcher.getStatus(),
			},
		});
	});

	// POST /trigger-click - Trigger a specific click
	app.post("/trigger-click", async (req, res) => {
		const { sessionName, clickId } = req.body;
		if (!sessionName || !clickId) {
			res.status(400).json({ error: "sessionName and clickId required" });
			return;
		}

		try {
			const clickScheduler = getClickScheduler();
			const result = await clickScheduler.triggerClick(sessionName, clickId);
			if (!result) {
				res.status(404).json({ error: `Click "${clickId}" not found for ${sessionName}` });
				return;
			}
			res.json({ success: true, result });
		} catch (err) {
			res.status(500).json({ error: String(err) });
		}
	});

	// POST /reload-clicks - Reload clicks for a session (or all)
	app.post("/reload-clicks", async (req, res) => {
		const { sessionName } = req.body || {};

		try {
			const clickScheduler = getClickScheduler();
			if (sessionName) {
				await clickScheduler.reload(sessionName);
			} else {
				await clickScheduler.reload();
			}
			const status = clickScheduler.getStatus();
			res.json({
				success: true,
				scheduled: status.length,
				status,
			});
		} catch (err) {
			res.status(500).json({ error: String(err) });
		}
	});

	// POST /trigger-event - Trigger a specific event
	app.post("/trigger-event", async (req, res) => {
		const { sessionName, filename } = req.body;
		if (!sessionName || !filename) {
			res.status(400).json({ error: "sessionName and filename required" });
			return;
		}

		try {
			const eventsWatcher = getEventsWatcher();
			const result = await eventsWatcher.triggerEvent(
				sessionName,
				filename.endsWith(".json") ? filename : `${filename}.json`
			);
			if (!result) {
				res.status(404).json({ error: `Event "${filename}" not found` });
				return;
			}
			res.json({ success: true, result });
		} catch (err) {
			res.status(500).json({ error: String(err) });
		}
	});

	// GET /stream - Server-Sent Events feed of agent tool activity
	app.get("/stream", (req, res) => {
		res.set({
			"Content-Type": "text/event-stream",
			"Cache-Control": "no-cache",
			Connection: "keep-alive",
		});
		res.flushHeaders();
		const off = onAgentEvent((e) => {
			const wanted = req.query.session;
			if (!wanted || wanted === e.session) {
				res.write(`data: ${JSON.stringify(e)}\n\n`);
			}
		});
		req.on("close", off);
	});

	// Bind to localhost only
	app.listen(port, "127.0.0.1", () => {
		console.log(`[dashboard-bridge] Control API listening on http://127.0.0.1:${port}`);
	});
}
