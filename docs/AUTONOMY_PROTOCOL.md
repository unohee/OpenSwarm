# OpenSwarm Autonomy Work Protocol

Governance for how the autonomous daemon **picks, orders, isolates, and cleans up**
work. These are not style conventions — they are **system-enforced invariants**.
Agents are LLMs and will not self-police; the daemon code must make violations
impossible, not merely discouraged.

> **Core tenet** — Respect order · honor isolation · treat the tracker as intent
> truth and the durable ledger as execution truth · preserve uncertain artifacts.
> **When in doubt, stop rather than proceed.**

The crash/restart state machine, fenced leases, durable outbox, and rollout modes
are specified in [DURABLE_AUTONOMY.md](DURABLE_AUTONOMY.md).

This protocol was distilled from a 2026-06-22 incident where the daemon processed a
numbered chain out of order (issue #8 before its blocker #7), spawned orphan
worktrees, looped on the same file conflict, executed meta/EPIC issues, and could
not be stopped because "Backlog" was treated as a work queue and local taskState
overrode Linear.

---

## Rules

### R1 — Dependency & order gating
A task is **not executable** until everything it depends on is resolved.
- Honor Linear `blocked-by` relations, EPIC→sub-issue order, and title numbering
  (`[step 7]` before `[step 8]`).
- **Failure prevented:** KT-308 (`[하네스이식 8]`, blocker KT-307) started before KT-307.
- **Enforcement:** `linear.ts` must fetch `blockedBy` (+ parse "블로커:" text);
  `decisionEngine.filterExecutableTasks` → `getTaskReadiness` gates on it. → **INT-1809**

### R2 — Meta issues are not executable
Parent / EPIC / tracking (umbrella) issues are never picked for the worker pipeline.
- **Failure prevented:** INT-1702 (tracking, already decomposed) and KT-300 (EPIC) were selected.
- **Enforcement:** `filterExecutableTasks` skips issues that have children / EPIC type / tracking label. → **INT-1810**

### R3 — Conflict avoidance & sequencing
Issues that would touch overlapping files must not run concurrently; on conflict,
**sequence** them — never loop indefinitely deferring.
- Conflict computation must honor `.gitignore` (exclude `trash/`, `.openswarm/`, coverage).
- **Failure prevented:** repeated `kyte_cli/cmd/issue.py` conflict deferral; `trash/openclaw/` (624650 scanned entities, normal ~1,594) producing hundreds of false shared files.
- **Enforcement:** knowledge/registry scan honors `.gitignore`; conflict detector excludes ignored paths; sequencer picks a deterministic winner instead of dropping both. → **INT-1810**

### R4 — Worktree reclaim (1 issue = 1 worktree, uncertain work is preserved)
Every issue runs in exactly one worktree. Terminal/proven-orphan worktrees are
reclaimed; crash-ambiguous or dirty worktrees are preserved for reconciliation.
- **Failure prevented:** orphan worktrees (`1562d0c7`, `9d46189b`, `fab12f10`, `403ec530`) accumulated because `removeWorktree` only ran on PR-creation success.
- **Enforcement:** durable active-worktree markers are written immediately after
  creation; startup pruning accepts only terminal ledger paths or proven orphans.

### R5 — Tracker intent and durable execution have separate authority
Local `taskState` is subordinate to Linear/local tracker intent, while
`automation.db` exclusively owns execution claims. If an issue's tracker state becomes
non-actionable (Backlog / Done / Canceled) or it becomes blocked, any in-flight
local `in_progress` entry is invalidated, not restored.
- **Failure prevented:** an issue set to Backlog kept running because `~/.openswarm/task-state.json` held `in_progress`; the daemon even flipped Linear back to In Progress.
- **Enforcement:** reconcile taskState against Linear each heartbeat; Linear wins. Define which states are actionable (don't treat Backlog as a queue by default). → **INT-1809**

### R6 — Isolation is a hard denylist
`allowedProjects` and `removedConfigPaths` are authoritative. Auto-discovery
(`basePaths`) must never re-add a removed/denied repo.
- **Failure prevented:** `repos.json` auto-rediscovery kept re-adding isolated repos (kyte-portal, OpenSwarm) to `pinned`/`enabled` between heartbeats.
- **Enforcement:** rediscovery filters against `removedConfigPaths`; the denylist is honored on every write. → **INT-1810**

### R7 — Operator intervention is respected immediately
When a human changes an issue's state/assignee/priority, the next heartbeat
reflects it. The daemon never reverts an operator action.
- **Failure prevented:** operator set KT-308 to Backlog; the daemon reverted it to In Progress.
- **Enforcement:** Linear state read fresh (cache invalidated on external change); no write-back that contradicts the operator. → **INT-1809**

---

## Enforcement status

| Rule | Enforced by | Status |
|------|-------------|--------|
| R1 Dependency/order gating | INT-1809 | planned |
| R2 Meta-issue exclusion | INT-1810 | planned |
| R3 Conflict avoidance + ignore-aware scan | INT-1810 | planned |
| R4 Worktree reclaim | INT-1810 | planned |
| R5 Linear = source of truth | INT-1809 | planned |
| R6 Isolation denylist | INT-1810 | planned |
| R7 Operator intervention respected | INT-1809 | planned |

Until R1–R7 are enforced in code, a project is only safely controlled by removing
it from `allowedProjects` + `removedConfigPaths` (see R6). kyte-portal and OpenSwarm
are isolated this way as of 2026-06-22.
