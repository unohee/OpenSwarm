# Cron Jobs (Scheduler)

> **Cron vs Heartbeat?** See [CRON_VS_HEARTBEAT.md](./CRON_VS_HEARTBEAT.md)

Cron is the built-in scheduler. It stores jobs, wakes up agents at the appropriate time, and optionally delivers output to chat.

_If you want "run every morning"_ or _"wake the agent in 20 minutes"_, cron is the mechanism.

## TL;DR

- Cron runs **inside the service** (not inside the model)
- Jobs are persisted to survive restarts
- Two execution styles:
  - **Main session**: Queues system events, executed at next heartbeat
  - **Isolated**: Runs a dedicated agent turn, optionally delivers output
- Wakeup is first-class: "wake now" vs "next heartbeat"

## Quick Start

```typescript
// One-shot reminder
await cronService.addJob({
  name: "Reminder",
  schedule: { kind: "at", atMs: Date.now() + 20 * 60 * 1000 },
  sessionTarget: "main",
  wakeMode: "now",
  payload: { kind: "systemEvent", text: "Check: document draft" },
  deleteAfterRun: true,
});

// Recurring isolated job
await cronService.addJob({
  name: "Morning brief",
  schedule: { kind: "cron", expr: "0 7 * * *", tz: "Asia/Seoul" },
  sessionTarget: "isolated",
  payload: {
    kind: "agentTurn",
    message: "Summarize overnight updates.",
    deliver: true,
    channel: "discord",
  },
});
```

## Concepts

### Schedules

Three schedule kinds:

- `at`: One-shot timestamp (epoch ms). Accepts ISO 8601, converts to UTC.
- `every`: Fixed interval (ms).
- `cron`: 5-field cron expression + optional IANA timezone.

```typescript
// Examples
{ kind: "at", atMs: 1738262400000 }
{ kind: "every", everyMs: 3600000 }  // Every hour
{ kind: "cron", expr: "0 7 * * *", tz: "Asia/Seoul" }  // Daily at 7 AM
```

### Main vs Isolated Execution

#### Main session jobs (system events)

Main jobs queue system events and optionally wake the heartbeat runner.
Must use `payload.kind = "systemEvent"`.

- `wakeMode: "next-heartbeat"` (default): Waits for the next scheduled heartbeat
- `wakeMode: "now"`: Triggers immediate heartbeat execution

Best when you want the normal heartbeat prompt + main session context.

#### Isolated jobs (dedicated cron sessions)

Isolated jobs run a dedicated agent turn in a `cron:<jobId>` session.

Key behaviors:
- Prompt is prefixed with `[cron:<jobId> <job name>]` for tracking
- Each execution starts a **new session id** (no carryover from previous conversations)
- Posts a summary to the main session (prefixed with `Cron`, configurable)
- If `wakeMode: "now"`, triggers immediate heartbeat after posting the summary
- If `payload.deliver: true`, output is delivered to the channel; otherwise kept internal

Use isolated jobs for noisy, frequent, "background jobs" that shouldn't spam the main chat history.

### Payload Shapes

Two payload kinds:

```typescript
// For main session
{ kind: "systemEvent", text: "Next heartbeat: check calendar." }

// For isolated session
{
  kind: "agentTurn",
  message: "Summarize today's inbox + calendar.",
  model: "opus",  // Optional: model override
  thinking: "high",  // Optional: thinking level
  deliver: true,
  channel: "discord",
  to: "channel:1234567890",
}
```

### Delivery (channel + target)

Isolated jobs can deliver output to a channel:

- `channel`: `discord` / `slack` / `telegram` / `whatsapp` / `last`
- `to`: Per-channel recipient target

```typescript
// Discord example
{ channel: "discord", to: "channel:1398253695174709319" }

// Telegram topic example
{ channel: "telegram", to: "-1001234567890:topic:123" }
```

## Decision Flowchart

```
Does the task need to run at a precise time?
  YES -> Use cron
  NO  -> Continue...

Does the task need isolation from the main session?
  YES -> Use cron (isolated)
  NO  -> Continue...

Can this task be batched with other periodic checks?
  YES -> Use heartbeat (add to HEARTBEAT.md)
  NO  -> Use cron

Is this a one-shot reminder?
  YES -> Use cron with --at
  NO  -> Continue...

Need a different model or thinking level?
  YES -> Use cron (isolated) with model/thinking
  NO  -> Use heartbeat
```

## Cost Considerations

| Mechanism | Cost Profile |
|-----------|-------------|
| Heartbeat | One turn every N minutes; proportional to HEARTBEAT.md size |
| Cron (main) | Adds event to next heartbeat (no isolated turn) |
| Cron (isolated) | Full agent turn per job; can use cheaper models |

**Tips**:
- Keep `HEARTBEAT.md` small to minimize token overhead
- Batch similar checks in heartbeat instead of multiple cron jobs
- Use isolated cron with cheaper models for routine tasks
