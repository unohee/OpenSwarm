# Changelog

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
