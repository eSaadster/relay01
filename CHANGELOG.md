# Changelog

## Unreleased

### Added
- **AG-UI event stream:** a shared agent event bus (`src/api/agent-events.ts`), a live `✅/🔄/❌` step checklist in the Slack message, and a `GET /stream` SSE endpoint on the dashboard bridge.
- **Block Kit generative UI:** a `render_ui` tool that renders tables, key/value cards, unicode bar charts, and buttons inline (`src/slack/blocks.ts`), with Slack length/limit guards.
- **Reaction feedback:** 👍/👎 on a bot reply writes guidance into the session scratchpad `critical[]` memory (requires the `reactions:read` scope).

### Removed
- Dropped the dead warelay/WhatsApp/Twilio inheritance: the old reply pipeline (`reply`, `command-reply`, `claude`, `pi`, `transcription`, `templating`), Twilio/WhatsApp media hosting (`media/{host,server,store,mime,…}`), the relay command queue, tmux relay helper, and the unused JSON session store — verified unreachable from `src/index.ts`.

### Changed
- Added a real `vitest.config.ts` (the `package.json` "vitest" block was never read) that excludes the `.tmp/` scratch dir.
- De-warelay'd branding in logging, version, env, and port-conflict messages; removed the deprecated `WarelayConfig` alias.
