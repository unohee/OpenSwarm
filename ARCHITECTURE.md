# OpenSwarm Architecture

This document describes how OpenSwarm actually works today. It is the source of truth for
the system's structure; the README is the short version. Every claim points at a file so it
stays honest as the code evolves.

## 1. What it is

OpenSwarm is an autonomous AI agent orchestrator. A daemon polls a task source (Linear or a
local SQLite store), decides which task to run next, and drives each task through a
**Planner → Worker → Tester → Reviewer** pipeline inside an isolated git worktree, opening a
PR when the work passes. Models are pluggable (Codex/GPT/OpenRouter/local) behind a single
agentic tool loop, and everything is configured, not hardcoded.

## 2. Entry points

`src/cli.ts` defines the `openswarm` commands:

| Command | What it does |
|---|---|
| `start` | Boot the daemon (background by default, `--foreground` to run inline). Background mode forks and polls the heartbeat to confirm liveness (`cli.ts:166`). |
| `run <task>` | One-off task with no config. `--pipeline` (full stages), `--worker-only`, `--model`, `--max-iterations` (`cli.ts:28`). |
| `exec <prompt>` | Run a task via the daemon (auto-starts it); `--local` bypasses the daemon (`cli.ts:138`). |
| `init` | Interactive first-run wizard, or `--yes` for non-interactive config generation (`cli.ts:60`). |
| `validate` | Validate `config.yaml`, report agent / autonomous / PR-processor status (`cli.ts:90`). |
| `chat` | Blessed TUI cockpit (`cli.ts:122`). |
| `dash` | Web dashboard, port 3847 (`cli.ts:251`). |
| `check` | Code registry inspection + BS detector (`cli.ts:282`). |
| `auth` | OAuth/PKCE login for GPT / OpenRouter (`cli.ts:343`). |

`openswarm start` boots `src/core/service.ts:startService()`, which loads config, optionally
initializes Linear/Discord/web/notifier, selects the task source, and starts the autonomous
runner plus optional PR processor / CI worker / daily reporter.

## 3. Autonomous execution flow

`src/automation/autonomousRunner.ts` + `runnerExecution.ts`, wired in `core/service.ts`.

```
Cron heartbeat (schedule, e.g. */5 * * * *)
  └─ fetch tasks from task source (Linear slim-mode / SQLite)
     └─ filterAlreadyProcessed  (drop completed; defer system-blocked — see §6)
        └─ DecisionEngine picks ONE task (scope guard, cooldown, daily cap)
           └─ resolveProjectPath  (allowedProjects → ~/dev/<name>)
              └─ draft analysis    (fast pre-read, optional; draftAnalyzer.ts)
                 └─ Planner         (decompose if estimated > threshold; planner.ts)
                    └─ create git worktree (worktreeMode)
                       └─ PairPipeline.run()  →  §4
                          └─ syncSuccessState / logPairComplete → Linear/SQLite Done
                             └─ record outcome to cognitive memory + repo knowledge
                                └─ commitAndCreatePR (push + gh pr create)
```

Concurrency is governed by `TaskScheduler` (`orchestration/taskScheduler.ts`):
`maxConcurrentTasks` global slots, and — with `worktreeMode` on — multiple tasks of the same
project run in parallel, each in its own worktree (`isProjectBusy` returns false under
worktreeMode, so the global slot count is the only limit).

## 4. The pipeline: Planner → Worker → Tester → Reviewer

`src/agents/pairPipeline.ts`. Stages are selected by `getEnabledStages(roles)`
(`runnerExecution.ts:855`): **worker** and **reviewer** are on unless explicitly disabled;
**tester**, **documenter**, **auditor**, **skill-documenter** are opt-in via
`roles.<stage>.enabled`.

### Per-iteration loop (`runFullIterationLoop`, pairPipeline.ts:780)

For each iteration (up to `maxIterations`, default 3):

1. **Planner** (pre-pipeline, `planner.ts`) — runs once before the loop when the task is large
   (estimated > `decomposition.thresholdMinutes`). Read-only exploration, then emits a JSON
   plan; creates Linear sub-issues with dependencies and marks the parent decomposed. The plan
   is handed to the worker as execution context.

2. **Worker** (`agents/worker.ts`) — takes a git snapshot, runs the agentic loop (read_file /
   write_file / edit_file / search_files / **bash**), then diffs git. The **git diff is the
   real signal** — it overrides the model's self-reported file list. Workers must *run* scripts
   with `bash` to produce execution artifacts (reports, benchmark results), not just write them.

3. **Pipeline guards** (`agents/pipelineGuards.ts`) — conventional-commit check, quality gate,
   fake-data guard. A blocking failure injects a `revise` and restarts from the worker.

4. **Tester** (`agents/tester.ts`) — **runs before the reviewer** so the reviewer can judge the
   code together with real test outcomes. Skipped when no code files changed. **Blocking**: a
   test failure triggers `revise` immediately, before a review pass is spent.

5. **Reviewer** (`agents/reviewer.ts`) — judges the worker's code **and the tester results**
   (`testerResult` is passed into the review prompt) against the task's explicit requirements.
   The reviewer prompt is deliberately pragmatic (anti-perfectionism: only blocking defects or
   unmet explicit requirements cause `revise`). Decision: `approve` / `revise` / `reject`.
   `revise` → next iteration (worker again); `reject` → terminate.

Across iterations a **StuckDetector** watches for no-progress loops and aborts early.

### Post-pass (non-blocking, after all stages pass)

`Documenter` → `Auditor` → `SkillDocumenter` (pairPipeline.ts:272-307), each skipped under its
own condition (no file change, too few files, etc.). None of these can fail the task.

### Failure / defer semantics

- A reviewer `revise` loop that exhausts `maxIterations` (3) returns `finalStatus: 'failed'`.
- The runner tracks a per-task failure count; at `MAX_RETRY_COUNT` (2) it **defers** the issue
  to **Backlog** on Linear (non-recoverable) and stops re-selecting it, so a task that the
  worker genuinely cannot finish (e.g. an environment-bound benchmark) does not starve the
  backlog. Reviewer max-rejection (3) defers symmetrically.
- `filterAlreadyProcessed` only "recovers" a deferred task when a human moves it back to
  **Todo** — system-left `In Progress` state is not treated as a manual retry signal
  (otherwise the block would be cleared every heartbeat).

## 5. Adapters & the agentic loop

`src/adapters/`. One agentic loop, many model backends.

| Adapter | Backend |
|---|---|
| `codex-responses` | OpenAI Codex via OAuth, runs on OpenSwarm's own agentic loop (tools under our control) |
| `gpt` | OpenAI Chat API via OAuth |
| `openrouter` | any OpenRouter model (native agentic loop, ZDR) |
| `local` | Ollama / llama.cpp |
| `lmstudio` | LM Studio (OpenAI-compatible) |

`agenticLoop.ts` drives the tool loop: send prompt + tool definitions → model returns text or
tool calls → execute tools, append results → repeat until the model stops. Long histories are
compacted (keep recent turns). Guards in the loop: a no-edit guard (a worker that never edits
is a failure) and a read-loop guard that nudges only near the turn budget, not mid-investigation.

Tools (`tools.ts`, `TOOL_DEFINITIONS`): `read_file`, `write_file`, `edit_file`, `search_files`,
`bash` (120s default timeout — benchmarks load models and exceed 30s). Optional `web_fetch` /
`web_search`, plus any MCP server tools from `mcp.json`.

## 6. Support components

| Component | File | Role |
|---|---|---|
| Task source | `automation/taskSource.ts` | `ITaskSource` over Linear (`LinearTaskSource`) or local SQLite (`SqliteTaskSource`) — runs SaaS-free if needed |
| Worktree manager | `support/worktreeManager.ts` | per-issue worktree, branch, commit + `gh pr create`; auto-adds a CI workflow when missing; never commits `.openswarm/*` (local-exclude + `rm --cached`) |
| PR processor | `automation/prProcessor.ts` | cron: re-runs the pipeline on CI-failing PRs, adds CI to CI-less PRs, leaves CI-green PRs for **manual merge** (no auto-merge) |
| Conflict resolver | `automation/conflictResolver.ts` | auto-resolves merge conflicts on owned PRs (worker edits the conflict markers → commit → push); cleans leftovers before checkout |
| Cognitive memory | `memory/memoryCore.ts` | LanceDB vector store, Xenova multilingual-e5-base embeddings; beliefs/strategies/constraints with TTL |
| Knowledge graph | `knowledge/` | codebase AST + dependency scan, impact analysis, GraphQL export for worker context |
| Locale / i18n | `locale/` | `en` / `ko` catalogs + agent prompts; comments and reports follow `config.language` |
| Notifier | `notify/notifier.ts` | outbound Discord / Slack / Telegram / webhook |
| Discord bot | `discord/` | interactive control surface (`!status`, etc.) |
| Web dashboard | `support/web.ts` | live pipeline stages, cost, worktrees, logs on port 3847 |

## 7. Model routing

`DefaultRolesConfig` (`core/types.ts`) sets per-role models (worker/reviewer/tester/…), each
with `model`, `adapter`, `effort`, `timeoutMs`, `maxTurns`, and `escalateModel` /
`escalateAfterIteration` (escalate to a stronger model after repeated failure). Optional
`jobProfiles` override role models by estimated task size, so cheap work routes to a light tier
and hard work to a frontier tier — the reviewer is never cheaped out (a wrong approve or a
wrong reject costs more than the model).

## 8. File map (orientation)

```
src/
├─ cli.ts                       entry: openswarm commands
├─ index.ts                     daemon main()
├─ core/        service.ts (orchestrator) · config.ts · types.ts · eventHub.ts
├─ automation/  autonomousRunner.ts · runnerExecution.ts · taskSource.ts
│               prProcessor.ts · conflictResolver.ts · ciWorker.ts
├─ agents/      pairPipeline.ts (orchestrator) · worker.ts · reviewer.ts
│               tester.ts · documenter.ts · auditor.ts · draftAnalyzer.ts · pipelineGuards.ts
├─ adapters/    index.ts · agenticLoop.ts · tools.ts · {codexResponses,gpt,openrouter,local,lmstudio}.ts
├─ orchestration/ decisionEngine.ts · taskScheduler.ts
├─ support/     planner.ts · worktreeManager.ts · gitTracker.ts · costTracker.ts
├─ memory/      memoryCore.ts · repoKnowledge.ts
├─ knowledge/   graph.ts · scanner.ts · analyzer.ts · graphqlExporter.ts
├─ linear/ · github/ · discord/ · issues/ (sqliteStore) · locale/ · notify/
```
