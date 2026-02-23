# Cron vs Heartbeat: When to Use Each

Both heartbeat and cron jobs can execute tasks on a schedule. This guide helps you choose the right mechanism for your use case.

## Quick Decision Guide

| Use Case | Recommended | Reason |
|----------|-------------|--------|
| Check inbox every 30 minutes | Heartbeat | Batch with other checks, context-aware |
| Daily report at exactly 9 AM | Cron (isolated) | Requires precise timing |
| Monitor calendar for upcoming events | Heartbeat | Natural fit for periodic awareness |
| Weekly deep analysis | Cron (isolated) | Independent task, can use different model |
| Remind me in 20 minutes | Cron (main, `--at`) | One-shot with precise timing |
| Background project health check | Heartbeat | Piggyback on existing cycle |

## Heartbeat: Periodic Awareness

Heartbeat runs in the **main session** at regular intervals (default: 30 minutes). Designed to let the agent check things and surface what's important.

### When to use heartbeat

- **Multiple periodic checks**: Instead of 5 separate cron jobs checking inbox, calendar, weather, notifications, and project status, a single heartbeat can batch them all.
- **Context-aware decisions**: The agent has full main session context, so it can wisely decide what's urgent vs. what can wait.
- **Conversation continuity**: Heartbeat runs share the same session, so they remember recent conversations and can follow up naturally.
- **Low-overhead monitoring**: One heartbeat replaces many small polling tasks.

### Heartbeat advantages

- **Batch multiple checks**: One agent turn can review inbox, calendar, and notifications together.
- **Fewer API calls**: A single heartbeat is cheaper than 5 isolated cron jobs.
- **Context-aware**: The agent knows what it's working on and can prioritize accordingly.
- **Smart suppression**: If nothing needs attention, the agent responds `HEARTBEAT_OK` and no message is delivered.
- **Natural timing**: Drifts slightly with queue load, which is fine for most monitoring.

### Heartbeat example: HEARTBEAT.md checklist

```md
# Heartbeat checklist

- Check email for urgent messages
- Review calendar for events in the next 2 hours
- If background tasks completed, summarize results
- If idle for 8+ hours, send a brief check-in
```

The agent reads this at each heartbeat and handles all items in one turn.

## Cron: Precise Scheduling

Cron jobs run at **precise times** and can run in isolated sessions without affecting the main context.

### When to use cron

- **Precise timing needed**: "Send every Monday at 9 AM" (not "sometime around 9 AM")
- **Independent tasks**: Tasks that don't need conversation context.
- **Different model/thinking**: Heavy analysis requiring a more powerful model.
- **One-shot reminders**: "Remind me in 20 minutes" with `--at`
- **Noisy/frequent tasks**: Tasks that would clutter the main session history.
- **External triggers**: Tasks that must run independently regardless of whether the agent is active.

### Cron advantages

- **Precise timing**: 5-field cron expression with timezone support.
- **Session isolation**: Runs in `cron:<jobId>` without polluting main history.
- **Model override**: Use cheaper or more powerful models per job.
- **Delivery control**: Can deliver directly to a channel; by default still posts summary to main (configurable).
- **No agent context needed**: Runs even if the main session is idle or compressed.
- **One-shot support**: Precise future timestamps with `--at`.

### Cron example: Daily morning briefing

```typescript
{
  name: "Morning briefing",
  schedule: { kind: "cron", expr: "0 7 * * *", tz: "Asia/Seoul" },
  sessionTarget: "isolated",
  payload: {
    kind: "agentTurn",
    message: "Generate today's briefing: weather, calendar, key emails, news summary.",
    model: "opus",
    deliver: true,
    channel: "discord",
  },
}
```

Runs at exactly 7 AM Seoul time, uses Opus for quality, delivered directly to Discord.

## Combining Both

The most efficient setup uses **both**:

1. **Heartbeat** handles routine monitoring (inbox, calendar, notifications) as a batched turn every 30 minutes.
2. **Cron** handles precise schedules (daily reports, weekly reviews) and one-shot reminders.

### Example: Efficient automation setup

**HEARTBEAT.md** (checked every 30 minutes):

```md
# Heartbeat checklist

- Scan for urgent emails
- Check calendar for events in the next 2 hours
- Review pending tasks
- Light check-in if quiet for 8+ hours
```

**Cron jobs** (precise timing):

```typescript
// Daily 7 AM morning briefing
{ name: "Morning brief", schedule: { kind: "cron", expr: "0 7 * * *" }, ... }

// Monday 9 AM weekly project review
{ name: "Weekly review", schedule: { kind: "cron", expr: "0 9 * * 1" }, model: "opus", ... }

// One-shot reminder
{ name: "Call back", schedule: { kind: "at", atMs: Date.now() + 2*60*60*1000 }, ... }
```

## Main Session vs Isolated Session

|  | Heartbeat | Cron (main) | Cron (isolated) |
|--|-----------|-------------|-----------------|
| Session | Main | Main (via system event) | `cron:<jobId>` |
| History | Shared | Shared | Fresh each run |
| Context | Full | Full | None (clean start) |
| Model | Main session model | Main session model | Overridable |
| Output | Delivered unless `HEARTBEAT_OK` | Heartbeat prompt + event | Posts summary to main |

## Cost Considerations

| Mechanism | Cost Profile |
|-----------|-------------|
| Heartbeat | One turn every N minutes; proportional to HEARTBEAT.md size |
| Cron (main) | Adds event to next heartbeat (no isolated turn) |
| Cron (isolated) | Full agent turn per job; can use cheaper models |

**Tips**:
- Keep `HEARTBEAT.md` small to minimize token overhead.
- Batch similar checks in heartbeat instead of multiple cron jobs.
- Use isolated cron with cheaper models for routine tasks.
