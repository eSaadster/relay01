# Background Timer for Pi-Agent Session Cleanup

## Current Behavior (Reactive)

Sessions are only checked for idle timeout when a new message arrives. If a user stops messaging, their agent sits in memory indefinitely until they return.

```
Hour 0:00 - User messages → session created
Hour 1:00 - (nothing happens, session sits in memory)
Hour 6:00 - User messages → "idle for 6 hours" → summarize → new session
```

## Recommendation: Add Background Timer (Proactive)

Add a periodic timer that checks for idle agents and triggers summarization proactively.

### Benefits

- **Memory efficiency**: Evict idle agents within ~90 min instead of indefinitely
- **Data safety**: Scratchpad written to disk sooner (less risk of losing context on crash)
- **Predictable behavior**: Sessions always summarize ~60-90 min after going idle

### Implementation

```typescript
// In PiAgentManager constructor
constructor(config: PiAgentConfig = {}, idleTimeoutMinutes = 60) {
  this.config = config;
  this.idleTimeoutMs = idleTimeoutMinutes * 60 * 1000;

  // Start background cleanup timer (check every 30 min)
  this.cleanupInterval = setInterval(() => {
    this.cleanup();
  }, 30 * 60 * 1000);
}

// Add cleanup interval property
private cleanupInterval: NodeJS.Timeout | null = null;

// Add method to stop timer (for graceful shutdown)
stopCleanupTimer(): void {
  if (this.cleanupInterval) {
    clearInterval(this.cleanupInterval);
    this.cleanupInterval = null;
  }
}
```

### Behavior With Timer

```
Hour 0:00 - User messages → session created
Hour 0:30 - Timer runs → idle 30 min < 60 min → nothing
Hour 1:00 - Timer runs → idle 60 min → summarize → evict
Hour 1:30 - Timer runs → no agents → nothing
Hour 2:00 - User messages → load scratchpad → new session
```

### Considerations

- Timer interval (30 min) is independent of idle threshold (60 min)
- Worst case: agent evicted 30 min after becoming idle (60 + 30 = 90 min after last message)
- Best case: agent evicted immediately when idle threshold reached
- Should call `stopCleanupTimer()` on process shutdown
