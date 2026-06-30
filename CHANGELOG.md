# Changelog

## 0.10.1 — 2026-07-01

### Fixed

- **PM synthesis JSON parsing** — `review --max`'s PM agent failed to parse codex-responses' **escaped JSON** output (literal `\n` / `\"`), so synthesis produced no grouped issues and only the master issue remained. `parseSynthesisOutput` now decodes an escaped JSON block before parsing. (INT-2239)
- **Orphan audit issue** — when a repo has no `openswarm.json` `linear.projectId` mapping, `review --max` now warns instead of silently filing the master issue without a project (and, on a multi-team config, on the wrong team). Run `openswarm add` in the repo to map it. (INT-2239)

## 0.10.0 — 2026-06-30

Full-codebase review pipeline (multi-agent audit → report → PM triage → Linear), chat session persistence, and a batch of daemon / TUI / adapter fixes.

### Added

- **`openswarm review --max`** — full-codebase audit that fans reviewer subagents out over directory-shaped areas, with **area isolation + dedup** so a shared file isn't flagged by every area. Persists a markdown report to `.openswarm/audit/audit-<ts>.md` and files a Linear master issue by default (`--out`, `--no-linear`). (INT-2006, INT-2022)
- **PM agent issue synthesis (default)** — `review --max` files Linear issues by default as **at most 10 cohesive issues** (a master parent + synthesized sub-issues), grouped by an LLM PM by theme/root-cause instead of one-per-follow-up. `--no-linear` skips Linear (report only); `--issues-per-area` keeps the legacy per-area filing; `--issues <id>` sets an existing parent. (INT-2225)
- **Codex usage-limit handling + claude fallback** — typed `RateLimitError` from the rich `x-codex-*` 429 headers (used %, reset time), early-abort instead of hammering a dead quota, and **automatic fallback to the `claude` adapter** (Claude subscription) for the remaining areas (`--fallback`, `--no-fallback`). (INT-2192)
- **Chat session persistence + `openswarm resume`** — conversations persist to `~/.openswarm/chat`; `resume` reopens the latest with its goal. `/goal clear` is the only way to stop an in-flight goal. (INT-2014)
- **Execution cwd context** — chat / `/plan` / `/goal` operate in the repo `openswarm` was launched from. (INT-2005)
- **Project selection persistence** — the daemon's enabled-project selection survives restarts. (INT-2208)
- **Planner rich-markdown sub-tasks** — each sub-task description is a full markdown doc (Background / Investigation / Approach / Completion) so the worker starts with context. (INT-1581)
- **`edit_file` fuzzy fallback** — line-normalized matching (whitespace / quotes / unicode) when exact match fails, plus edit prompt guidelines. (INT-2011)

### Fixed

- **Daemon kept running after every project was disabled** — an empty enabled-set was treated as "run all"; now an explicit "disable all" actually stops the daemon (and persists across restarts). (INT-2207, INT-2208)
- **Multi-team config `createIssue`** — passed the comma-joined teamId string to Linear ("teamId must be a UUID"); now resolves a single team (the project's, else the first). (INT-2210)
- **Ink TUI color consistency** — hardcoded color literals + uncolored status text routed through the theme scheme; new `running` / `info` tokens. (INT-2209)
- **Hangul input doubling** — multi-grapheme / N-repeat cases collapsed. (INT-2012)
- **Adapter CLI infra errors no longer counted as STUCK** — codex CLI / usage-limit errors are infra, not task failures. (INT-2010)
- **Linear project overview summary doubling** — strip the prior compact summary before re-appending. (INT-1907)
- **Cancel syncs task-state to Backlog.** (#162)

> Note: 0.8.x–0.9.x were tagged without changelog entries; see git history for those.

## 0.7.0 — 2026-06-19

Runs with **no external SaaS** from a clean install, plus a native ChatGPT-OAuth Codex path.

### Added

- **First-run onboarding wizard (`openswarm init`)** — interactive 3-step setup: AI provider (with inline `auth login`, skipped if already authenticated), task backend (local SQLite or Linear paste-key), and an optional notification channel (Discord/Slack/Telegram/webhook, BYO). Writes `.env` (secrets, `chmod 600`) + `config.yaml` and validates. `--yes`/`--non-interactive` keeps the config-only path for CI. New `promptHelper` (line-event-queue prompts, robust for piped stdin + TTY) and `envFile.writeEnvVars` (upsert, 0600). (INT-1578)
- **Notifier abstraction** — outbound notifications are decoupled from Discord: `Discord` / `Slack` / `Telegram` / generic `Webhook` / `Noop`, selected by a `notifications` config block and injected via `setNotifier`. `EmbedBuilder` falls back to text/markdown for non-Discord channels. (INT-1576)
- **Linear-optional task source (`ITaskSource`)** — the autonomous runner + `/plan` cockpit route through `ITaskSource`. With no `LINEAR_API_KEY`, `selectTaskSource` falls back to the existing local SQLite issue store (`~/.openswarm/issues.db`) and drives the runner end-to-end — no external account. `LinearTaskSource` preserves today's behavior exactly (thin delegation). (INT-1577)
- **Codex model discovery (`openswarm auth models`)** — discovers the Codex models an account can actually use via the OAuth backend (`chatgpt.com/backend-api/codex/models`), with `~/.codex` config/cache and a curated offline fallback; ported from the hermes `codex_models` pattern. `CodexCliAdapter.listModels()`. (INT-1585)
- **Native Codex Responses adapter (`codex-responses`)** — calls `chatgpt.com/backend-api/codex/responses` (Responses API) via ChatGPT OAuth on OpenSwarm's **own** agentic loop, instead of delegating to the external `codex exec` CLI. Tools/verification stay under OpenSwarm's control, and per-role model tiering (worker/reviewer/planner = big/medium/small) works on a single OAuth. Live-verified (`/responses` 200 + tool-calling e2e). (INT-1586)

### Fixed

- **OAuth `account_id` extraction** — stored `id_token.sub` (an IdP subject, e.g. `google-oauth2|…`) instead of `chatgpt_account_id` from the access_token's `https://api.openai.com/auth` claim, so the Codex backend would 401. Existing profiles need a one-time `openswarm auth login --provider gpt` re-login. (INT-1586)
- **`pairMode.webhookUrl` validation** — was a strict `z.string().url()`, so an unset `${PAIR_WEBHOOK_URL:-}` (empty string) made `openswarm validate` fail on every generated config (broken since 0.6.0). Now allows an empty string, matching the other optional `webhookUrl` fields. (INT-1578)

## 0.6.0 — 2026-06-18

### Added

- **TUI Planner Cockpit (`/plan <goal>`)** — the TUI is no longer just chat + a read-only monitor. `/plan` runs the Planner to preview a decomposition, gates on human approval (`y` / `n` / `edit` to drop sub-tasks), then dispatches into the daemon loop; progress shows in the Tasks tab. Available in both the blessed TUI (`chat`) and the readline chat. (INT-1572)
- `POST /api/plan/dispatch` — dual-path dispatch: with Linear configured it creates a parent issue + dependency-wired sub-issues and triggers a heartbeat (reusing the autonomous decomposition engine); otherwise it falls back to running each sub-task through the exec pipeline.
- **Web tools in the agentic loop** — `web_fetch` (keyless: URL → readable text) and `web_search` (pluggable backend: Tavily/Brave when `TAVILY_KEY`/`BRAVE_SEARCH_KEY` is set, else a keyless DuckDuckGo fallback) are now exposed to every adapter (openrouter/gpt/local), restoring the web capability the `claude -p` harness used to provide. Enabled by default (`webTools` option); disabled for the SWE-bench harness to keep the benchmark honest. (INT-1573)

### Changed

- **Planner migrated off `claude -p`** — `runPlanner` now runs through the OpenSwarm agentic loop via the configured adapter (read-only, multi-turn) instead of shelling out to `claude -p --max-turns 1`. Completes the INT-1420 `claude -p` removal, drops the claude-binary dependency, and lets the planner read the codebase before decomposing. `PlannerResult` contract unchanged.
- Extracted `createSubIssuesWithDependencies()` from the autonomous runner so the `/plan` endpoint and `decomposeTask` share one sub-issue/dependency engine (no logic fork).
- Extracted `startExecTask()` in the web server so `POST /api/exec` and the `/plan` fallback share one exec-task lifecycle.

## 0.5.0 — 2026-06-11

### Added

- **OpenRouter adapter** — runs OpenSwarm's native agentic tool loop against any OpenRouter model, with OAuth PKCE (or `OPENROUTER_API` key), ZDR (`data_collection: deny`) for non-OpenAI models, automatic Anthropic prompt caching, and optional reasoning-off for mechanical roles. (#63)
- **LM Studio adapter** — dedicated OpenAI-compatible endpoint support with auto model selection (`LMSTUDIO_BASE_URL`, `LMSTUDIO_MODEL`). (#60)
- **Repo knowledge loop** — workers learn each repository over time: task outcomes are stored as per-repo memories (success → `system_pattern`, review rejection → `constraint` pitfall) and recalled by relevance into the next worker prompt as a "Repository Knowledge" section. (#63)
- **L0–L6 benchmark suite** (`benchmarks/`) — synthetic L0–L5 tasks with deterministic grading plus L6 = real SWE-bench Lite instances solved by the OpenSwarm harness and graded by the official swebench harness. Includes a hybrid mode (frontier read-only diagnosis + lightweight implementer) that resolved 3/3 attempted instances; see `benchmarks/RUBRIC.md`. (#63)
- Agentic-loop guards, all motivated by SWE-bench findings: final-answer turn on turn exhaustion, no-edit guard (`nudgeMaxOnNoEdit`, counts only successful edits), verification-harness file protection (`protectedFiles`), and configurable bash timeout (`bashTimeoutMs`) with an explicit TIMEOUT message. (#63)

### Changed

- Worker success is now judged primarily by git diff instead of requiring a structured JSON block from the model.
- Default model routing is benchmark-driven: lightweight worker (`z-ai/glm-4.7-flash`) with frontier escalation; frontier planner/reviewer.
- Compaction thresholds raised for modern context windows (24k→60k tokens, keep 16 recent messages) — fixes an infinite re-read loop on long agentic runs.
- `loadConfig` now disables Discord/Linear integration when credentials are missing (standalone mode) instead of rejecting the config.
- Repo memory keys are normalized via realpath so symlinked/trailing-slash paths share one knowledge store.

### Fixed

- Working directory is injected into agentic prompts — models no longer guess absolute paths and get every file tool call rejected.
- bash tool failures now return stdout/stderr + exit code (grep "no match" was previously treated as a fatal error, causing infinite retries).
- `edit_file` result snippets now locate the edit via the unique `old_string` position (previously could show the wrong region).
- gpt/local adapters now forward the new guard options to the agentic loop.

## 0.4.4 — 2026-05-07

### Security

- Re-publish of 0.4.3 to ensure the `protobufjs` `^7.5.5` override (CVE-2026-41242 / GHSA-xq3m-2v4x-88gg, critical RCE, CVSS 9.8) is actually present in the npm tarball. The override was merged into `main` for 0.4.3 but was not included in the package that reached npm. No code changes beyond the version bump; the override entry already lives in `package.json`.

## 0.4.3 — 2026-05-07

### Fixed

- Fixed `ReferenceError: require is not defined` crash in `expandPath` that broke every `openswarm exec`/`run --path <absolute-path>` invocation. The package is ESM (`"type": "module"`) but `src/core/config.ts` lazily called CommonJS `require('node:path')` to import `resolve`. Hoisted `resolve` into the top-level `node:path` import. (#52, reported by @shuklatushar226)
- Fixed the same ESM-incompatible lazy `require('node:fs')` pattern in `src/automation/runnerState.ts` (`mkdirSync`), which would have crashed on the first daily-pace directory creation.

### Security

- Forced `protobufjs` to `^7.5.5` via `package.json` `overrides` to mitigate CVE-2026-41242 / GHSA-xq3m-2v4x-88gg (critical RCE via crafted protobuf descriptors). The vulnerable copy was pulled in transitively through `@xenova/transformers` → `onnxruntime-web` → `onnx-proto`. OpenSwarm itself loads only trusted HuggingFace models, but the override removes the dependency-tree exposure entirely.

## 0.4.2 — 2026-04-25 (addendum — shipped in 0.4.2 but previously unrecorded)

### Added

- Added a canonical OpenSwarm task-state store for hierarchy, dependencies, worktree ownership, and execution status.
- Added a Python/Pydantic mirror model for the canonical task-state schema.
- Added structured Linear state-sync comments for machine-readable issue snapshots.
- Added task-state rehydration from the latest Linear sync comment during autonomous fetch.

### Changed

- Planner decomposition now resolves child-task dependencies into canonical state instead of leaving them as description-only text.
- Dependent child issues are no longer all promoted immediately; only dependency-free children start runnable.
- Decomposed parent issues now stay active until all child issues complete, then close automatically.
