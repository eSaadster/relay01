# pi-durable port plan (Relay-01)

This moves Relay-01's agent runtime from `@earendil-works/pi-agent-core`'s in-memory `Agent` to `@earendil-works/pi-durable`, the same move Klaus made on `dev/pi-agent` (see `~/warelay/pi-durable-port-plan.md`). Every input, model turn and tool call is committed to storage before anything is shown. If the relay dies mid-reply, reopening the storage picks the work up where it stopped.

The shared memory in `~/relay01/memory` stays as it is: the global and user scopes, the pending inbox and the consolidation pass. Only the places where that memory meets the agent change.

pi-durable's README says: "Experimental. The API changes without notice between releases." Plan for that: pin exact versions and keep a way back (see Rollback).

*Revised 2026-11-25 after a code check and a Fable review; status updated after Phase 0 steps 1–3. Changes: sandbox blocker, conversations keyed by Slack ids, explicit delivery records, corrected request ids, inbox behaviour on stop, idempotent harvest, rollback.*

---

## Status (2026-11-25)

- **Phase 0 is done, apart from the human Slack checks.** `relay01` runs pi-ai and pi-agent-core **1.3.0** on `dev-rlm` at `9e6ab91` (a merge of `dev/pi-durable`). Deployed 2026-11-25 16:14Z, and real calls pass: gpt-6-luna, the summarizer, opencode-go, and a click via the bridge. `dev/pi-durable` is at the same commit, ready for Phase 1.
- **Last 0.74 state:** `a3207e1`, with lockfile `~/relay01-backups/pnpm-lock.pre-step10.yaml`. Roll back with `git reset --hard a3207e1`, then restore that lockfile, run `pnpm install --frozen-lockfile` and `pm2 restart relay01`.
- **Fixed along the way** (not from the port):
  - `fd4ad63`: the summarizer had no API key since the gpt-6-luna switch, so eviction summaries, harvest and consolidation silently returned nothing.
  - `a3207e1`: opencode-go needed an `x-opencode-session` header and per-model `baseUrl`.
  - `models.json`: dead `deepseek-v4-flash` removed; `kimi-k2.6` replaced with `kimi-k3.1-pro`.
- **Phase 1 is built, not deployed:** `dev/pi-durable` `3d4db7d`, `4183e86`, `008324e` (`src/auto-reply/durable.ts`, `durable-setup.ts`, `durable.test.ts`). Build clean, 121 tests pass, and a real gpt-6-luna turn through the host saw all three seeded memory facts. Nothing calls the host until Phase 2.
- **Phase 2 is built, not deployed:** `dev/pi-durable` `9813875`…`0a0f0af` (`src/slack/durable-slack.ts` plus wiring in `slack.ts`, `main.ts`, `events/watcher.ts`). Build clean, 128 tests pass. With no flag set and no `durable-sessions.json`, `DurableSlack.fromEnv()` returns undefined and every path is legacy. Blocker 4 is confirmed: RLM children are the pi CLI over RPC and never open the storage. **Deployed 2026-11-25 17:04Z** (`dev-rlm` `0a0f0af`, fast-forward from `9e6ab91`, lockfile backup `~/relay01-backups/pnpm-lock.pre-phase2.yaml`). `USE_DURABLE=true` is set for `@saad` only. `~/relay01/state` (700) is gitignored along with `memory/` and `slack/`. Nightly backup: cron 03:15 runs `~/relay01-backups/backup-durable.sh`, keeping 7 days. DM trial in progress.
- **Older rollback point:** tag `pre-durable` (`ea08348`). `pnpm-lock.yaml` is gitignored, so its copy is at `~/relay01-backups/pnpm-lock.pre-durable.yaml`.
- **Port work:** Phases 0–2 are merged into `dev-rlm`. The `dev/pi-durable` branch and the `~/klaus-slack-durable` worktree were removed on 2026-11-25. Recreate them from `dev-rlm` for Phase 3.
- **Memory tools are live.** `USE_MEMORY_TOOLS=true` is set in `~/relay01/slack/.env:14` and `klaus-slack/.env:10`, and dotenv loads both at boot (`src/index.ts:29-32`).
- **Sandbox fixes are live** (Blocker 5):
  - `023aaf2`: search shell injection, symlink escapes.
  - `e18ad0f`: bash skill-mode keyword bypass, stopgap.
  - The artifacts server patch, outside git.
- **Artifacts tunnel** (`cloudflared`) has been down since 2026-08-21, so artifact URLs don't resolve publicly. Unrelated to the port.

---

## What Relay-01 gets

- **Replies survive restarts.** Today a kill mid-reply loses the turn. Only the scratchpad, written at eviction, survives.
- **A durable inbox.** Today a message that arrives during a reply gets "Already working on something" and is dropped (`src/slack/main.ts:191`). With the inbox it waits, and it survives a restart.
- **Duplicate protection.** `requestId = channel:ts` makes a Socket Mode redelivery harmless. (A mention that arrives as both `app_mention` and `message` is already deduped, at `slack.ts:422-423`.)
- **A log that stays intact.** The transcript is no longer something that exists only until a 12-hour timer fires. Fact harvesting can read it again after a failure.
- **Fresh shared memory.** Global and user memory are read on every request, not frozen when the agent is created.

---

## What has to keep working: shared memory

Read in code:
- `~/relay01/memory/global/` and `~/relay01/memory/users/<slackUserId>/` each hold `MEMORY.md` (injected), `pending.jsonl` (proposals) and `pending.archive.jsonl` (audit trail) (`memory-store.ts`).
- Global memory is injected into every session. User memory is injected only into that user's DM (`pi-agent.ts:520-536`). The injected text is capped at 6,000 characters per scope.
- Session `critical` bullets from `scratchpad/session.md` go into the system prompt on every request (`pi-agent.ts:512-514`). The prompt at `pi-agent.ts:509` tells the agent to save there.
- Facts reach `pending.jsonl` in two ways:
  - **Eviction.** On 12 hours idle or 300 messages, `triggerSummarization` (`pi-agent.ts:724`) summarizes the last 150 messages (`pi-agent-summarizer.ts:151`) and proposes the `promote` and `promote-user` sections. User facts come only from DMs. `promote` (global) is **not** limited to channels: DMs feed global memory too, guarded only by the prompt (`pi-agent.ts:745`, `pi-agent-summarizer.ts:184`).
  - **`memory_write`.** Live.
- `maybeConsolidate*` merges the inbox into `MEMORY.md` once it passes a threshold, then archives what it merged.

**The risk.** pi-durable has no eviction. If the port keeps eviction as the only harvest path, shared memory silently stops growing. Harvest needs its own trigger (Phase 3).

---

## Blockers to clear first

### 1. pi-ai 0.74 → 1.3
pi-durable 1.3 pins `pi-ai` and `chord` 1.3.0 exactly, so the whole repo moves together. Klaus's Phase 1 covers the same breaks:
- The root entrypoint is core-only. Direct calls (`getModel`, `getModels`, `getProviders`, `completeSimple`, `streamSimple`) import from `@earendil-works/pi-ai/compat`.
- `Agent` needs a `streamFn` (compat `streamSimple`).
- The system prompt travels as the transcript's leading system message, not a state field.
- Auth is provider-scoped. Check the Codex token refresh and fallback (`16c85e8`).
- `ToolCall.arguments` and `ToolResultMessage.details` must be JSON.

Files that import pi-ai or pi-agent-core (in `src/auto-reply/`): `pi-agent.ts`, `pi-agent-summarizer.ts`, `pi-agent-scratchpad.ts`, `pi-agent-tools.ts`, `memory-tools.ts`, `clicks/runner.ts`, `skills/types.ts`, `skills/registry.ts` and `skills/builtin/digitalocean.ts`.

### 2. Reply closures die with the process
`ctx.respond`, `ctx.replaceMessage`, `ctx.uploadFile` and the block renderer are closures over one Slack event (`slack.ts:583`). A reply resumed after a restart has nothing to call. The submission has to carry what delivery needs: channel, `thread_ts`, user, source (`dm` or `channel`) and, once posted, the placeholder message's `ts`. A resumed reply updates that placeholder with `chat.update` if it has one, and otherwise posts fresh with `chat.postMessage`.

### 3. What the model sees
Klaus resets after 80 messages and lets OptChat build the view, with pi-durable compaction off. Relay-01 has no OptChat. Decision for the first pass: **pi-durable's own transcript and compaction** (`settings.compaction`). Klaus has never run with compaction on (`pi-durable.ts:689`). A compaction that fails at the blocking threshold fails the generation as `unanswered` (README:484). So:
- Soak it on one busy channel before Phase 4.
- Show the user an error when a generation fails that way.
- Keep a fallback: a reset after N messages, as Klaus does, carrying a fresh summary forward.

### 4. One process per storage
pi-durable allows one process per storage. Checked: `api/dashboard-bridge.ts` runs inside the relay process (`main.ts:539`). Still to check: the RLM RPC children and any admin endpoint. Anything that prompts a session must go through the relay.

### 5. Sandbox escapes — fixed (stopgap for skill mode)
`durable.sqlite` will hold every DM's transcript, so the agent must not be able to read files outside its session. There were three holes, plus one in the artifacts server:
- **`search` runs a host shell command built by string interpolation** (`pi-agent-tools.ts:416-427`). `filePattern` goes into `--include="…"` unescaped, and `pattern` only has `"` escaped. So `$(…)` or backticks in either one run on the host, outside bwrap, as the relay user. That reaches `~/relay01/slack/.env` (Slack tokens), `~/.pi/agent/auth.json`, every user's memory and, after the port, `durable.sqlite`. Fix: `execFile("grep", [...args])` with no shell, and `--` before the pattern.
- **`createSandboxPath` checks the path string, not the real path** (`pi-agent-tools.ts:70-104`). `bash` runs in bwrap with the scratchpad writable, so the agent can `ln -s /home/clawd/relay01/durable.sqlite x`. Host-side `read_file x`, `search` or `attach x` then follows the link. Fix: `fs.realpath` the resolved path (or its nearest existing parent, for writes) and check it against the real scratchpad, session root and skills directories.
- **Fixed in `023aaf2`:** the two holes above.
- **`bash` skill mode skipped bwrap on a keyword match.** The match was anywhere in the command (`pdf`, `npx `, `/skills/`, …), so `cat ~/relay01/slack/.env # pdf` ran on the host. **Stopgap in `e18ad0f`:**
  - Only `[bash|sh|python|python3|node] <script in global or session skills dir> [plain args]` runs outside bwrap, through `execFile` with no shell. `RELAY01_SESSION` is set to the session.
  - Scripts in `skills/artifacts/files/` never run outside bwrap.
  - bwrap now mounts the skills dirs read-only and `skills/artifacts/files/` read-write.
- **Artifacts server followed symlinks.** `~/relay01/slack/skills/artifacts/server.js` (not in git) now checks the real path. A link in `files/` to an outside file would otherwise have been served at a public URL. Backup: `server.js.bak-2026-11-25`.
- **Still open (full fix, after the port):** run skills inside bwrap too, with only the binaries, caches and dirs each needs. Since the stopgap, `pip install --user` and `npm install` into `~` fail, and so do scripts that need user-installed packages.

### 6. Sessions are keyed by mutable names
The session key is `@userName` for DMs and `#channelName` for channels (`main.ts:77-79`). When `users.info` fails, the fallback is the raw id (`slack.ts:310-316`). `~/relay01/slack/` already holds `@unknown`, `@user` and `#C096P5WHXHP`. A renamed or reused handle can move a DM, and the user memory injected into it, to another person. On durable, a forked key also forks the conversation silently.
- **Key conversations by Slack ids:** the channel id for channels, and for DMs the IM channel id plus the user id. The name stays as the folder name and display label, mapped in `durable-sessions.json`.
- Before injecting user memory, check that the incoming `event.user` equals the stored `userId`.
- Never create a conversation from an `@unknown` or `@user` fallback. Log the failure and reply without a session instead.

---

## Mapping

| Relay-01 today | pi-durable |
|---|---|
| `PiAgentManager`, one `Agent` per session, 12 h idle / 300-message eviction | One `Harness` over `~/relay01/state/durable.sqlite`, one conversation per Slack id key (Blocker 6). `contextRetentionMs` replaces eviction |
| session name → agent map | `~/relay01/state/durable-sessions.json` (atomic write): id key → `{ conversationId, folder, userId, isDm }` |
| system prompt built once in `createAgent`, with memory blocks prepended | Extension section for the static prompt. Memory blocks and session `critical` bullets are added by a `beforeRequest` hook on every request |
| context warm-up from `scratchpad.recentTurns` | Gone. The transcript is durable |
| `agent.prompt(text)` | `conv.submit({ type: "input", content, entry: { kind: "slack.message", data: { channel, threadTs, user, source } }, requestId })` |
| `agent.subscribe` → `onToolActivity`, step checklist, `emitAgentEvent` | `watchEvents()` in a `ChatRuntime`, as in Klaus |
| `activeRuns` + "Already working on something" | Inbox: `followUp` only, plus a "queued" reply |
| `stop` → `resetSession` (summarize, then evict) | Abort the current run only (see Phase 2 step 7). The transcript stays; the harvester covers it |
| `promptLocks` | Gone: the conversation serializes runs |
| `triggerSummarization` at eviction → `proposeGlobalFacts` / `proposeUserFacts` | Harvester with a cursor per conversation (Phase 3) |
| events watcher `manager.prompt` (`events/watcher.ts:356`) | Submission, `entry.kind: "relay.event"`, `requestId = session:filename:scheduledFireTime`. The bare event key (`watcher.ts:42-43`) repeats for periodic events (`watcher.ts:318`), so it would dedupe every firing after the first |
| agent completion / question notes (`main.ts:471`, `:498`) | Submission, `entry.kind: "relay.agent-note"`, `requestId = runId:done` for completion and `runId:question.id` for questions (`agents/types.ts:87-88`) |
| self-correct repair attempt (`pi-agent.ts:948-1000`) | Port as a second submission with `requestId = <original>:retry`, as Klaus does (`pi-durable.ts:402`) |
| approval-aware timeout (`pi-agent.ts:921`) | Same countdown around the durable run, re-armed for runs resumed at startup. A pending approval does not survive a restart |
| per-session `.env` (`PI_AGENT_MODEL`) | Keep `loadSessionEnv` |
| background agents (`agents/runner.ts`, pi-rlm over RPC), summarizer and clicks `Agent` uses (`pi-agent-summarizer.ts:242`, `clicks/runner.ts:262`) | Unchanged. They keep using `Agent` |

### Tool replay policy
After a crash a tool reruns only if it is `replay: "safe"`. Otherwise the model gets an `interrupted` error result.
- **Safe:** `read_file`, `list_directory`, `search`, `web_search`, `web_fetch`, `get_current_time`, `canvas_sections_lookup`, `agent_status`, `memory_query`, and the read-only DigitalOcean tools (`do_list_apps`, `do_app_logs`, `do_app_spec`, `do_list_deployments`, `do_list_alerts`).
- **Never safe:** `bash`, `write_file`, `send_message`, `canvas_create`, `canvas_edit`, `attach`, `render_ui`, `render_chart`, `render_diagram`, `generate_image`, `edit_image`, `agent_run`, `agent_answer`, `agent_steer`, `agent_stop`, `mcp` (it proxies reads and posts alike) and the `digitalocean` umbrella tool.
- **`memory_write`:** unsafe until proposals carry an id (Phase 3), then safe.
- Unlisted tools default to unsafe.

---

## Delivery and failure model

These rules hold on every path: live, resumed and orphaned.

- **Delivery is recorded.** After a reply's final post succeeds, append a `relay.delivered` write entry to the conversation, holding the request id and the message `ts`. Record the placeholder `ts` the same way when it is first posted.
- **At startup,** deliver every settled run that has no `relay.delivered` entry, not only unsettled ones (Klaus's `deliverOrphan`, `pi-durable.ts:610-634`, covers only unsettled ones). Update the placeholder if one is recorded; otherwise post fresh.
- **Maximum age.** Don't deliver an orphan more than 2 hours old. Post one short note instead ("I restarted and lost track of a reply to this; ask again if you still need it"). `[SILENT]` (`watcher.ts:359`) holds on this path too.
- **Harness failure.** A storage error ends the Harness for every session (README:715). When `harness.closed` settles unexpectedly, log it and exit, and let pm2 restart. Count resume attempts per submission in a doc. After 3, abort that submission with a note to the user, so one run that keeps crashing can't put the relay in a crash loop.
- **Storage location and backup.** `~/relay01` is a git checkout, and its `memory/` and `slack/` are untracked, not ignored. Past re-clones have wiped them. Put durable files in `~/relay01/state/`, add `state/`, `memory/` and `slack/` to `.gitignore`, and set mode 600 on `durable.sqlite` and its `-wal` and `-shm` files. Run a nightly `sqlite3 .backup` to `~/relay01-backups/`, keeping 7 days.

---

## Rollback

There must be a way back until Phase 4 has run for a week:
- Tag `pre-durable` (`ea08348`) is the last state before 1.3. Its lockfile is at `~/relay01-backups/pnpm-lock.pre-durable.yaml`. To revert the upgrade: check out the tag, copy that lockfile back, run `pnpm install --frozen-lockfile`, then `pm2 restart relay01`.
- Keep writing `scratchpad/session.md` (`critical` and summary) from the harvester until Phase 4 is done, so a session taken off durable has its memory.
- **Taking a session off durable:** abort its conversation, delete its entry in `durable-sessions.json`, remove `USE_DURABLE` from its `.env`, and restart. It returns to `PiAgentManager` with its `session.md`.
- Delete the old path (Phase 4 step 2) only after a week with no rollback.

---

## Phases

### 0. Clean tree, sandbox fix, dependency upgrade (no pi-durable yet)
1. ~~Commit the four uncommitted model files.~~ Done: `ea08348`.
2. ~~Fix Blocker 5 and deploy.~~ Done: `023aaf2`, `e18ad0f` and the artifacts server patch. Live since 2026-11-25.
3. ~~Tag `pre-durable`, create `dev/pi-durable` and the worktree `~/klaus-slack-durable`, copy the lockfile, install.~~ Done. Lockfile backup in `~/relay01-backups/`.
4. Bump `@earendil-works/pi-ai` and `@earendil-works/pi-agent-core` to 1.3.0. Pin `@sinclair/typebox` as Klaus does.
5. Move direct pi-ai calls to `@earendil-works/pi-ai/compat`. Give `Agent` a `streamFn`.
6. Move the system prompt to the transcript's leading system message.
7. Check auth: OAuth refresh, the Codex CLI token fallback and custom providers in `findModel`.
8. Run `pnpm build` and `vitest run`. Record the failures that already existed.
9. Smoke test with real calls under a separate HOME: `gpt-6-luna` answers, a tool call validates, the summarizer, clicks and consolidation run.
10. Stop `relay01`, fast-forward, restart. Check a DM, a channel mention and a click. If anything breaks, go back to `pre-durable`.

### 1. Durable host behind a flag
1. Add `@earendil-works/pi-durable` 1.3.0.
2. Copy Klaus's `src/auto-reply/pi-durable.ts` as `src/auto-reply/durable.ts`. Remove the OptChat parts: the hook body, `optchat` logging, `previous`.
3. Open one `Harness` over `~/relay01/state/durable.sqlite` (`openNodeSqliteStorage`) with a pid file. Apply the storage rules from "Delivery and failure model".
4. Key conversations by Slack ids (Blocker 6). Write `durable-sessions.json` atomically. Set `userId` and `isDm` when the conversation is created, never from an incoming message.
5. Build `Models` with one bridge provider per Relay-01 provider, over `findModel` and `createGetApiKey`, as Klaus does.
6. Wrap the session tools and skill tools with `defineTool`. Apply the replay policy above.
7. Make one extension per session (`relay01:<key>`) with its tools and the static prompt as one section. Set `settings.extensions: []` so each conversation sees only its own.
8. Turn on `settings.compaction`. Log every compaction with its size before and after, and every `unanswered` failure.
9. Gate it with `USE_DURABLE=true` in a session's `.env`. Leave `PiAgentManager` in place for every other session. Read every session's flag once at startup and decide the path from that snapshot; changing a flag takes a restart. A session with an entry in `durable-sessions.json` stays durable until it is taken off through the Rollback steps.
10. **The `beforeRequest` hook comes now, not in Phase 3.** It injects global memory, user memory (DM only, with the `userId` check) and the session's `critical` bullets from `session.md`. So a flagged session gets the same context from its first request. Until Phase 3, a flagged session proposes facts only through `memory_write`. Keep the flag to your own DM and one test channel.

### 2. Slack wiring
1. **Ack first**, then submit as the first step after the ack. The handlers do `users.info`, file downloads and `createContext` before any agent call (`slack.ts:355-366`, `:398-415`), so a submit before the ack can't fit inside Slack's 3-second window. With id keys (Blocker 6), the submission needs only the raw event. File downloads move into the run. A crash between ack and submit loses that one message, and the window is a few milliseconds.
2. Use `requestId = channel:ts` for Slack messages. It covers Socket Mode redelivery.
3. Put `{ channel, threadTs, user, source }` in the submission entry.
4. Live replies keep using `ctx`: placeholder, step checklist, `replaceMessage`, uploads. Record the placeholder `ts` and the final delivery, as in "Delivery and failure model".
5. Add orphan delivery under the delivery rules above. It uploads `MEDIA:` files, and starts with "(I restarted partway through this reply, so here it is in full.)" if its first blocks had gone out. Keep `durable-streamed.json` as Klaus does.
6. Replace the `activeRuns` rejection with the inbox. A message that arrives during a reply waits as `followUp`. It gets an immediate "Queued behind N message(s)" reply in its thread, and later its own run and its own reply in its own thread. Keep a map from request id to live `ctx` for the queued submission, and fall back to orphan delivery after a restart. No `steer` in the first pass.
7. **`stop` aborts only the current run.** `conv.abort()` also withdraws every queued input (README:536), which would drop another user's message in the same channel. Abort the current run's tasks instead, or, if 1.3 can't do that, collect the queued submissions, abort, and resubmit them with their original request ids. Gate `stop` on the conversation's busy state, not on `activeRuns` (`main.ts:89`). This covers `main.ts:89` and the `/relay stop` slash command at `:366`. A timeout uses the same path.
8. Route the events watcher and the agent completion and question notes through `submit`, with the request ids from the Mapping table.
9. Keep the approval-aware timeout around the durable run, and re-arm it for runs resumed at startup.
10. **Startup order:** open the Harness, re-attach every conversation in `durable-sessions.json` (not from the `.env` flags), deliver undelivered settled runs, let the Harness resume, and only then connect the Socket Mode client.
11. Try it on your DM:
    - a normal exchange;
    - two messages back to back (the second gets "queued");
    - a duplicate;
    - `stop` while another message is queued (the queued one still runs);
    - a `web_search` cut off by `pm2 restart relay01` and finished afterwards;
    - a restart between "run settled" and "posted".

### 3. Shared memory on the durable path
1. **Injection.** Already built in Phase 1 step 10.
2. **Ids on proposals.** Add an optional `id` to `ProposedFact` (`memory-store.ts:230-234`). `proposeFacts` skips an `id` already in `pending.jsonl` or `pending.archive.jsonl`.
3. **Harvester cursor.** Keep it per conversation in a `defineDoc` app document: `{ harvestedTo, inFlight?: { from, to } }`.
4. **Trigger.** Run the harvester when a conversation has been idle 2 hours, and when the entries since the cursor pass 100 messages. Also run it once at startup for any conversation behind its cursor or with an `inFlight` window.
5. **Windows.** Before calling the model, write `inFlight = { from, to }` with at most 150 messages per window. A backlog is harvested window by window; nothing is cut off. A retry reuses the stored window, so the ids stay the same. Each proposal's id is `conversationId:from-to:n`. After the append succeeds, set `harvestedTo = to` and clear `inFlight`.
6. **Prompt.** Reuse the summarizer prompt for `promote`, `promote-user`, and `critical`/summary (written to `session.md` until Phase 4, for Rollback). Ask for `promote-user` only for DMs. **Don't ask for `promote` from DMs:** global facts come from channels and from explicit `memory_write` calls only. (This changes today's behaviour on purpose.)
7. **Failures.** A failed harvest leaves the cursor and `inFlight` as they were and runs again on the next trigger. Nothing is lost, because the log is intact.
8. **`memory_write`.** Set each proposal's id to `toolCallId`. Then mark it `replay: "safe"`.
9. **Consolidation.** Unchanged. `consolidateMemory` renames `MEMORY.md` first, then appends the archive, then rewrites `pending.jsonl` (`memory-store.ts:374-399`). A crash after the rename leaves the merged facts in both. The next pass merges them again, and the prompt's dedup rule absorbs that. This is accepted as a known issue.
10. **Checks:**
    - A fact said in your DM reaches `users/<id>/pending.jsonl`, never `global/` and never a channel's prompt.
    - A team-wide fact said in a channel reaches `global/pending.jsonl`.
    - After consolidation, the next request in an open session sees the new `MEMORY.md` without a restart.
    - A harvest killed mid-run, then resumed after more messages arrive, proposes nothing twice.
    - A 400-message backlog harvests in three windows.

### 4. Every session, no `PiAgentManager` path
1. Put every session on durable. Remove `USE_DURABLE`. Run it like this for a week before step 2.
2. Delete `PiAgentManager`'s agent map, the idle timer, the 300-message guard, `triggerSummarization`, the warm-up, `promptLocks` and `activeRuns`. The summarizer, clicks and background agents keep `Agent`.
3. Move session `critical` memory from `session.md` to a per-conversation doc, still injected by `beforeRequest`. Update the prompt at `pi-agent.ts:509` and the harvester to match. Then remove `pi-agent-scratchpad.ts`.
4. Point `/relay status` at `ChatRuntime.status()` across sessions.
5. Update `docs/session-summary.md` and `AGENTS.md`.
6. Check live: a DM, a channel mention, a subscribed thread, a click, a periodic event firing twice, a background-agent completion and question note, and a restart mid-reply in a channel.

### 5. Optional (separate plans)
- Port OptChat from Klaus (log, summary tree, view, `zoom`, `search_chat`) and turn compaction off.
- Run background agents as owned subagents instead of pi-rlm RPC children.

---

## Open questions

- **Compaction.** How does it behave on long channel sessions, and what does it cost? Answered by the soak test in Blocker 3.
- **One conversation per channel.** Memory scope is per channel, so the conversation stays per channel too. Threads share it, and each input gets its own run. Revisit if threads bleed context into each other.
- **Approvals across a restart.** An interrupted write comes back as an error, and the model may ask again. Is that acceptable, or should pending approvals be stored?
- ~~**Aborting one run in 1.3.**~~ Answered: yes.
  - `harness.abortTask(<live pi.generation task id>)` ends only the current run; queued inputs stay queued.
  - The queued inputs then need a write with `model: []` to start. `abortRun` in `durable.ts` does this, and the stop test covers it.
  - The resubmit fallback would not work: after `conversation.abort()`, resubmitting with the same request id returns the withdrawn submission.
- **Memory use.** Klaus's relay went from about 223 MB to 266 MB RSS with pi-durable. Watch `relay01` after Phase 4.
- **Remaining one-process checks.** The RLM RPC children (Blocker 4).

## Reference

- Klaus's plan: `~/warelay/pi-durable-port-plan.md`.
- Klaus's runtime: `~/warelay/src/auto-reply/pi-durable.ts` (`ChatRuntime`, `openHost`, `deliverOrphan`, the replay set) and `pi-durable.test.ts`.
- pi-durable README: `~/warelay/node_modules/.pnpm/@earendil-works+pi-durable@1.3.0_*/node_modules/@earendil-works/pi-durable/README.md` (`docs/spec.md` is not on disk). Examples: `20-inbox`, `25-compaction`, `31-reload-and-restart`.
- Relay-01 memory: `src/auto-reply/memory-store.ts`, `memory-tools.ts`, `pi-agent-summarizer.ts`.
