# Repository Guidelines

## Project Structure & Module Organization
- Source code: `src/`
  - `src/slack/` — Slack layer: `slack.ts` (MomBot: SocketMode + WebClient), `store.ts` (channel logs + attachments), `main.ts` (entry wiring), `blocks.ts`/`checklist.ts` (Block Kit + live step UI).
  - `src/auto-reply/` — agent core: `pi-agent.ts` (PiAgentManager), `pi-agent-tools.ts`, `pi-agent-scratchpad.ts`, `pi-agent-summarizer.ts`, plus the `clicks/`, `events/`, `agents/`, and `skills/` subsystems.
  - `src/api/` — `agent-events.ts` (event bus) and `dashboard-bridge.ts` (control + SSE server).
  - `src/cli/`, `src/config/`, `src/infra/`, `src/media/`, `src/process/` — CLI wiring, config, infra helpers, media parsing, subprocess exec.
- Tests: colocated `*.test.ts` (run by Vitest; `.tmp/` is excluded via `vitest.config.ts`).
- Docs: `docs/` (clicks, events, session summary, background timer). Built output lives in `dist/`.
- Runtime state lives under `~/relay01/slack/{session}/` (sessions, scratchpad memory, attachments, clicks/events).

## Build, Test, and Development Commands
- Install deps: `pnpm install`
- Run in dev: `pnpm dev` (tsx `src/index.ts`) or `pnpm start start <working-dir>`
- Type-check/build: `pnpm build` (tsc)
- Lint/format: `pnpm lint` (biome check), `pnpm format` (biome format)
- Tests: `pnpm test` (vitest); coverage: `pnpm test:coverage`

## Coding Style & Naming Conventions
- Language: TypeScript (ESM, NodeNext). Relative imports must use a `.js` extension.
- Prefer strict typing; avoid `any`. Format/lint via Biome before commits.
- Keep files concise; extract helpers instead of "V2" copies. Factor pure logic into exported, unit-testable functions.

## Testing Guidelines
- Framework: Vitest. Name tests after their source with `*.test.ts`.
- Run `pnpm test` before pushing when you touch logic. Build (`pnpm build`) must stay clean.

## Commit & Pull Request Guidelines
- Concise, action-oriented commit messages; group related changes and avoid bundling unrelated refactors.
- PRs should summarize scope, note testing performed, and mention any user-facing changes or new flags/scopes.

## Security & Configuration Tips
- Required env: `SLACK_APP_TOKEN` (xapp-…) and `SLACK_BOT_TOKEN` (xoxb-…); see `.env.example` and the README scope list.
- Optional per-session overrides live in `~/relay01/slack/{session}/.env`, `SYSTEM.md`, and `mcporter.json`.
- Never commit tokens or session data; `.env`, `data/`, and `.tmp/` are gitignored.

## Agent-Specific Notes
- The bot is typically managed by pm2 as `relay01`; after code changes restart with `pm2 restart relay01` and check `pm2 logs relay01` for a clean boot (`⚡️ Mom bot connected and listening!`).
- The dashboard/control API listens on `127.0.0.1:3456` (`/status`, `/stream` SSE, click/event triggers).
