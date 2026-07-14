# relay01

Slack bot powered by pi-agent with session persistence and scratchpad summarization.

## Overview

relay01 runs a `pi-agent` per Slack user/channel and connects over Socket Mode:

- Slack integration via SocketMode (events) + WebClient (outbound calls)
- A persistent `pi-agent` per session with scratchpad memory and session summarization
- Responds to channel @mentions and direct messages
- Filesystem-backed state under `~/relay01/slack/{session}/` (sessions, memory, attachments)

## Installation

```bash
npm install
npm run build
```

## Configuration

### Required Environment Variables

```bash
export SLACK_APP_TOKEN=xapp-...   # Slack app token for Socket Mode
export SLACK_BOT_TOKEN=xoxb-...   # Slack bot token for Web API
```

### Optional Environment Variables

```bash
export PI_AGENT_MODEL=claude-opus-4-5  # Model to use (default: claude-opus-4-5)
export PI_THINKING_LEVEL=off           # Thinking level: off, minimal, low, medium, high
export PI_TIMEOUT_MS=120000            # Timeout in milliseconds (default: 120000)
```

## Usage

```bash
# Start the bot
npm run slack start ./data

# Or using node directly
node dist/index.js start ./data

# Check environment status
node dist/index.js status
```

### CLI Commands

- `relay01 start <working-dir>` - Start the Slack bot with specified data directory
- `relay01 status` - Show bot status and environment check

## Architecture

```
Slack (SocketMode) → MomBot (slack.ts) → PiAgentManager (pi-agent.ts) → Reply to Slack
```

### Key Components

- `src/slack/slack.ts` - MomBot class handling Slack SocketMode + WebClient
- `src/slack/store.ts` - Channel data and attachment persistence
- `src/slack/main.ts` - Entry point wiring Slack to pi-agent
- `src/auto-reply/pi-agent.ts` - Pi Agent Manager with session persistence
- `src/auto-reply/pi-agent-tools.ts` - Agent tools (files, bash, web, `render_ui`, MCP, …)
- `src/auto-reply/pi-agent-scratchpad.ts` - Scratchpad memory persistence
- `src/auto-reply/pi-agent-summarizer.ts` - Session context summarization
- `src/slack/blocks.ts` / `src/slack/checklist.ts` - Block Kit rendering and live step checklist
- `src/api/agent-events.ts` / `src/api/dashboard-bridge.ts` - Agent event bus and control/SSE server
- `src/auto-reply/{clicks,events,agents,skills}/` - Scheduled tasks, wake-ups, sub-agents, skills

### Features

- **Session Persistence**: Per-session agents with idle timeout (12 hours default)
- **Scratchpad Memory**: Critical facts persisted across sessions under `~/relay01/slack/{session}/scratchpad/`
- **Session Summarization**: Automatic context compression when sessions expire
- **Channel & DM Support**: Responds to @mentions in channels and direct messages
- **Live step checklist**: Tool activity streams into the message (`✅/🔄/❌`), also exposed as SSE on the dashboard bridge (`GET /stream`)
- **Block Kit generative UI**: The agent can render tables, key/value cards, bar charts, and buttons inline via the `render_ui` tool
- **Reaction feedback**: 👍/👎 on a bot reply writes guidance into the session's scratchpad memory
- **Clicks**: Scheduled polling tasks (`clicks.json`) that alert when something needs attention
- **Events**: Filesystem-scheduled wake-ups (immediate / one-shot / cron) injected into the live session agent
- **Sub-agents**: Long-running `pi` child processes launched with `agent run ...`
- **Stop Command**: Say "stop" to cancel an active agent run

## Slack App Setup

1. Create a new Slack app at https://api.slack.com/apps
2. Enable Socket Mode and get an App-Level Token (xapp-...)
3. Add Bot Token Scopes:
   - `app_mentions:read`
   - `channels:history`
   - `channels:read`
   - `chat:write`
   - `files:read`
   - `files:write`
   - `groups:history`
   - `groups:read`
   - `im:history`
   - `im:read`
   - `im:write`
   - `reactions:read`
   - `users:read`
4. Install the app to your workspace
5. Get the Bot User OAuth Token (xoxb-...)
6. Add the bot to channels where you want it to respond

## License

MIT
