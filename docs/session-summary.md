# relay01 Slack Session Architecture

## Directory Structure

All session data lives under `~/relay01/scratchpad/slack/`:

```
scratchpad/
├── skills/                     # Global skills (available to all sessions)
│   └── image-gen/
│       ├── SKILL.md
│       ├── generate.sh
│       └── edit.sh
└── slack/
    ├── SYSTEM.md               # Global fallback system prompt
    ├── @username/              # DM session folder
    │   ├── SYSTEM.md           # User-specific system prompt
    │   ├── session.md          # Session history/memory
    │   └── skills/             # User-specific skills
    └── #channelname/           # Channel session folder
        ├── SYSTEM.md           # Channel-specific system prompt
        ├── session.md          # Shared channel session history
        └── skills/             # Channel-specific skills
```

## Session Keying

Sessions are keyed differently for DMs vs channels:

| Type    | Session Key      | Context Isolation                     |
|---------|------------------|---------------------------------------|
| DM      | `@username`      | Personal - only you see your history  |
| Channel | `#channelname`   | Shared - everyone in channel shares   |

This prevents personal DM context from leaking into group channels.

## System Prompt Hierarchy

When a session starts, the system prompt is loaded with fallback:

1. **Session-specific**: `slack/{sessionName}/SYSTEM.md` (checked first)
2. **Global fallback**: `slack/SYSTEM.md` (used if session-specific doesn't exist)

Examples:
- DM with @saad → tries `slack/@saad/SYSTEM.md`, falls back to `slack/SYSTEM.md`
- #vibe-corner → tries `slack/#vibe-corner/SYSTEM.md`, falls back to `slack/SYSTEM.md`

## Session Lifecycle

### Session Start (on first message)
1. Load scratchpad from `slack/{sessionName}/session.md` (if exists)
2. Load system prompt (with hierarchy above)
3. Inject critical memory items into system prompt
4. Discover skills (global + session-specific)
5. Create in-memory agent

### During Session
- Messages are processed by the in-memory agent
- Context accumulates in memory
- No files are written

### Session End (summarization triggers)
Summarization is triggered when:
- Session is idle for 12 hours
- Session reaches 300 messages
- User says "stop" while bot is actively processing

On summarization:
1. LLM summarizes the conversation
2. Extracts critical memory items
3. Saves to `slack/{sessionName}/session.md`
4. Agent is evicted from memory

## Skills System

### Global Skills
Located in `scratchpad/skills/`. Available to all sessions.

### Session Skills
Located in `slack/{sessionName}/skills/`. Only available to that session.

Skills are convention-based directories containing:
- `SKILL.md` - Instructions for using the skill
- Scripts/tools the agent can execute via bash

## File Formats

### session.md
```markdown
# Session Memory for @username

## summary
- Brief summary of past conversations

## critical
- Important facts to remember
- User preferences
- Key information

## recent
U: Last user message
A: Last assistant response
```

### SYSTEM.md
Plain text system prompt. Can include personality, rules, context.

Example:
```markdown
You are a helpful assistant for the marketing team.
Always be concise and professional.
```
