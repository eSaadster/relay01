# Clicks - Proactive Polling System

Clicks replace the legacy heartbeat system with a flexible, configurable proactive polling mechanism.

## Overview

A **click** is a scheduled task that:
1. Executes instructions at configured intervals
2. Evaluates results against alert criteria
3. Sends Slack alerts when conditions are met

## Configuration

### clicks.json Schema

```json
{
  "clicks": [
    {
      "id": "unique-id",
      "name": "Human Readable Name",
      "instructions": "Instructions for the agent to execute",
      "intervalMinutes": 10,
      "alertCriteria": "When to alert (optional - agent decides if omitted)",
      "enabled": true,
      "model": "claude-haiku-4-5"
    }
  ],
  "alertChannel": "#alerts"
}
```

### Fields

| Field | Required | Description |
|-------|----------|-------------|
| `id` | Yes | Unique identifier (lowercase, alphanumeric, dashes) |
| `name` | Yes | Human-readable name shown in alerts |
| `instructions` | Yes | What the agent should do |
| `intervalMinutes` | Yes | How often to run (1-1440) |
| `alertCriteria` | No | Explicit criteria; if omitted, agent decides |
| `enabled` | No | Default: true |
| `model` | No | Override model (default: claude-haiku-4-5) |
| `alertChannel` | No | Required for project-level clicks only |

### File Locations

| Location | Alert Target |
|----------|--------------|
| `~/relay01/slack/@username/clicks.json` | User's DM |
| `~/relay01/slack/#channel/clicks.json` | That channel |
| `~/relay01/slack/clicks.json` | Requires `alertChannel` |

## Slack Commands

| Command | Action |
|---------|--------|
| `reload clicks` | Reload clicks for your session |
| `clicks reload` | Same as above |
| `reload all clicks` | Reload all sessions' clicks |

## Architecture

### Module Structure

```
src/auto-reply/clicks/
├── index.ts        # Barrel exports
├── types.ts        # TypeScript interfaces
├── schema.ts       # Zod validation
├── discovery.ts    # Scan for clicks.json files
├── state.ts        # Persist click state
├── runner.ts       # Execute clicks via pi-agent
├── scheduler.ts    # Timer management (singleton)
└── alerts.ts       # Slack alert delivery
```

### Execution Flow

```
App Start
    │
    ▼
ClickScheduler.start()
    │
    ├─► discoverClicks() - scans ~/relay01/slack/ for clicks.json
    │
    └─► For each click: setInterval(runClick, intervalMs).unref()
                │
                ▼ (on interval)
        ClickScheduler.runClick()
                │
                ├─► Check if already running (skip if so)
                │
                ├─► ClickRunner.execute()
                │       │
                │       ├─► Create lightweight pi-agent
                │       ├─► Build prompt with instructions + criteria
                │       ├─► Run with 2-minute timeout
                │       ├─► Parse JSON response
                │       └─► Save state to scratchpad/clicks/
                │
                └─► If shouldAlert → sendClickAlert()
                        │
                        └─► Resolve target channel → post message
```

### State Storage

Click state is persisted to the session's scratchpad:

```
~/relay01/slack/@username/scratchpad/clicks/
├── .state.json           # Aggregated state for all clicks
└── {click-id}.md         # Per-click result log
```

**State file format (.state.json):**
```json
{
  "check-do-logs": {
    "clickId": "check-do-logs",
    "lastRunTime": 1733654400000,
    "lastResult": "OK",
    "lastSummary": "No errors found",
    "consecutiveFailures": 0
  }
}
```

**Result file format ({click-id}.md):**
```markdown
# Click: Check DO Logs
Last Run: 2025-12-08T10:30:00Z
Status: OK
Alert Sent: false
Duration: 1234ms

## Last Execution Summary
No errors found in the last 10 minutes.

## Details
Checked runtime logs, all clear.

## Execution Log
- 2025-12-08T10:30:00Z: OK - No errors found
- 2025-12-08T10:20:00Z: OK - No errors found
```

### Agent Prompt Format

```
## Click Execution: {name}

**Instructions:**
{instructions}

**Alert Criteria:**
{alertCriteria || "Use your judgment..."}

After executing, respond with a JSON block:
```json
{
  "shouldAlert": true/false,
  "summary": "Brief summary",
  "details": "Detailed findings"
}
```
```

## Integration Points

### main.ts

```typescript
import { getClickScheduler } from "../auto-reply/clicks/index.js";

// After bot.start()
const clickScheduler = getClickScheduler();
await clickScheduler.start({
  webClient: bot.getWebClient(),
  getChannelByName: (name) => bot.getChannelByName(name),
  getSessionChannelId: async (sessionName) => {
    if (sessionName.startsWith("@")) {
      return bot.getOrCreateDmChannel(sessionName.slice(1));
    }
    if (sessionName.startsWith("#")) {
      return bot.getChannelByName(sessionName.slice(1));
    }
  },
});
```

### slack.ts (new methods)

```typescript
getWebClient(): WebClient
getChannelByName(name: string): string | undefined
getOrCreateDmChannel(userName: string): Promise<string | undefined>
```

## Examples

### Session-level click (alerts to your DM)

`~/relay01/slack/@saad/clicks.json`:
```json
{
  "clicks": [
    {
      "id": "check-do-logs",
      "name": "Check DigitalOcean Logs",
      "instructions": "Use do_app_logs to check for errors in the last 10 minutes",
      "intervalMinutes": 10,
      "alertCriteria": "Alert if ERROR or FATAL found"
    }
  ]
}
```

### Project-level click (alerts to #alerts channel)

`~/relay01/slack/clicks.json`:
```json
{
  "clicks": [
    {
      "id": "health-check",
      "name": "Service Health Check",
      "instructions": "Fetch https://api.example.com/health",
      "intervalMinutes": 5,
      "alertCriteria": "Alert if non-200 status"
    }
  ],
  "alertChannel": "#alerts"
}
```

## Design Decisions

1. **Pi-agent for execution** - Full tool access (MCP, skills, web fetch, etc.)
2. **Haiku by default** - Cost-efficient for routine checks
3. **State in scratchpad** - Keeps config immutable, state inspectable
4. **setInterval().unref()** - Timers don't prevent process exit
5. **Concurrent run prevention** - Skips if click still executing
6. **2-minute timeout** - Prevents runaway executions

## Future Enhancements

- [ ] Cron expressions for complex schedules
- [ ] File watcher for automatic hot-reload
- [ ] Web dashboard for click management
- [ ] Execution metrics and history
- [ ] Click dependencies (run B after A)
