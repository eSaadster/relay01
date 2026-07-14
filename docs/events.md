# Events System

Events wake up your **session agent** with full context - conversation history, SYSTEM.md, memory, and everything the agent knows about you. Unlike clicks (which spawn isolated agents for background tasks), events use the same agent you chat with.

## Use Cases

- "Ask me how I'm doing every morning at 6am"
- "Remind me about my meeting at 3pm"
- External triggers (webhooks, pm2 crashes, emails) that need the agent's attention

## Event Location

Events are JSON files in your session's `events/` folder:

```
~/relay01/slack/@username/events/
~/relay01/slack/#channelname/events/
```

The watcher monitors these folders and schedules/executes events automatically.

## Event Types

### 1. Immediate

Executes instantly when the file is created. File is deleted after execution.

```json
{
  "type": "immediate",
  "text": "User just received an important email from the CEO"
}
```

**Use case:** External systems (webhooks, scripts) can write immediate events to trigger the agent.

### 2. One-shot

Executes at a specific datetime. File is deleted after execution. Past datetimes are ignored and deleted.

```json
{
  "type": "one-shot",
  "datetime": "2024-01-15T15:00:00+05:00",
  "text": "Reminder: You have a meeting with the design team in 15 minutes"
}
```

**Use case:** Reminders, scheduled one-time notifications.

### 3. Periodic

Executes on a cron schedule. File persists until manually deleted.

```json
{
  "type": "periodic",
  "cron": "0 6 * * *",
  "timezone": "Asia/Karachi",
  "text": "Good morning! Check in with user - ask how they're doing and if they need help with anything today."
}
```

**Cron format:** `minute hour day-of-month month day-of-week`

| Expression | Meaning |
|------------|---------|
| `0 6 * * *` | Every day at 6:00 AM |
| `0 */2 * * *` | Every 2 hours |
| `30 9 * * 1-5` | 9:30 AM on weekdays |
| `0 0 1 * *` | First day of every month at midnight |

**Use case:** Daily check-ins, recurring reminders, periodic status checks.

## Event Properties

| Property | Type | Required | Description |
|----------|------|----------|-------------|
| `type` | string | Yes | `"immediate"`, `"one-shot"`, or `"periodic"` |
| `text` | string | Yes | Message/instructions for the agent |
| `datetime` | string | One-shot only | ISO 8601 datetime with timezone offset |
| `cron` | string | Periodic only | Cron expression |
| `timezone` | string | No | IANA timezone (e.g., `"America/New_York"`). Defaults to system timezone. |
| `allowSilent` | boolean | No | If true, agent can respond with `[SILENT]` to suppress Slack notification |

## Silent Mode

For periodic events where the agent might not always have something to say, add `"allowSilent": true`. The agent can include `[SILENT]` in its response to suppress the Slack message.

```json
{
  "type": "periodic",
  "cron": "0 */4 * * *",
  "text": "Check if there are any urgent items that need user's attention. Only message if something important.",
  "allowSilent": true
}
```

## Slack Commands

| Command | Description |
|---------|-------------|
| `events` | List active events for current session |
| `list events` | Same as above |
| `trigger event <filename>` | Manually trigger an event (for testing) |

## Examples

### Daily Morning Check-in

`~/relay01/slack/@saad/events/morning-checkin.json`:
```json
{
  "type": "periodic",
  "cron": "0 6 * * *",
  "timezone": "Asia/Karachi",
  "text": "Good morning! How are you doing today? Is there anything I can help you with?"
}
```

### One-time Reminder

`~/relay01/slack/@saad/events/meeting-reminder.json`:
```json
{
  "type": "one-shot",
  "datetime": "2024-01-15T14:45:00+05:00",
  "text": "Heads up! Your meeting with the design team starts in 15 minutes."
}
```

### External Webhook Trigger

An external script can create an immediate event:

```bash
echo '{"type": "immediate", "text": "Alert: Production server CPU is at 95%"}' \
  > ~/relay01/slack/@saad/events/cpu-alert.json
```

### Periodic Status Check (Silent)

`~/relay01/slack/#ops/events/health-check.json`:
```json
{
  "type": "periodic",
  "cron": "0 */6 * * *",
  "text": "Check system health. Only alert if something needs attention.",
  "allowSilent": true
}
```

## Events vs Clicks

| Aspect | Events | Clicks |
|--------|--------|--------|
| **Agent** | Same session agent (full context) | New isolated agent (no context) |
| **Knows user** | Yes - history, memory, SYSTEM.md | No - starts fresh each time |
| **Scheduling** | Cron, datetime, or immediate trigger | Interval only (every X minutes) |
| **Response** | Natural conversation | Structured JSON (`shouldAlert`, `summary`, `details`) |
| **Use case** | Personal assistant reaching out | Background automation |
| **External triggers** | Yes (write a file) | No (interval-based only) |

### When to Use Events

- Agent needs to know YOU (your preferences, history, context)
- You want natural conversation ("How are you feeling?")
- External systems need to trigger the agent (webhooks, scripts)
- You need cron scheduling (more flexible than intervals)
- One-time reminders at specific times

### When to Use Clicks

- Task doesn't need personal context
- Background data processing (qualify leads, check APIs, monitor services)
- You want structured alerting with `shouldAlert` logic
- Task runs the same regardless of who it's for

### Example: Same Task, Different Approach

**"Check my email every hour"**

As a **click** (impersonal):
```json
{
  "id": "check-email",
  "instructions": "Check inbox for urgent emails. Return shouldAlert: true if any urgent.",
  "intervalMinutes": 60
}
```
Returns: `{shouldAlert: true, summary: "3 urgent emails"}`

As an **event** (personal):
```json
{
  "type": "periodic",
  "cron": "0 * * * *",
  "text": "Check my email and let me know if anything needs my attention."
}
```
Returns: "Hey, you got 3 emails - one from your boss about the Friday deadline. Want me to summarize it?"

The event version knows your context and can have a conversation about it.

## Implementation

### Source Files

| File | Description |
|------|-------------|
| [`src/auto-reply/events/types.ts`](../src/auto-reply/events/types.ts) | Type definitions for events |
| [`src/auto-reply/events/watcher.ts`](../src/auto-reply/events/watcher.ts) | EventsWatcher class - file monitoring and scheduling |
| [`src/auto-reply/events/index.ts`](../src/auto-reply/events/index.ts) | Module exports |
| [`src/slack/main.ts`](../src/slack/main.ts) | Integration with Slack bot startup |

### How It Works

1. **Startup**: `EventsWatcher.start()` is called after bot connects
2. **Scan**: Watcher scans all `~/relay01/slack/{session}/events/` directories
3. **Watch**: Uses `fs.watch` to monitor for file changes (100ms debounce)
4. **Schedule**:
   - Immediate → execute now, delete file
   - One-shot → `setTimeout` to datetime, delete after
   - Periodic → `Cron` job (via croner library)
5. **Execute**: Calls `manager.prompt(sessionName, message)` - same path as Slack messages
6. **Respond**: Sends agent response to Slack (unless `[SILENT]`)

### Technical Details

- Rescans for new session directories every 60 seconds
- Immediate events created before startup are skipped (prevents re-execution on restart)
- Uses [croner](https://github.com/hexagon/croner) for cron scheduling with timezone support
- File deletion cancels scheduled events
- File modification reschedules events
