# Changelog

## 0.4.4 — 2026-05-07

### Security

- Re-publish of 0.4.3 to ensure the `protobufjs` `^7.5.5` override (CVE-2026-41242 / GHSA-xq3m-2v4x-88gg, critical RCE, CVSS 9.8) is actually present in the npm tarball. The override was merged into `main` for 0.4.3 but was not included in the package that reached npm. No code changes beyond the version bump; the override entry already lives in `package.json`.

## 0.4.3 — 2026-05-07

### Fixed

- Fixed `ReferenceError: require is not defined` crash in `expandPath` that broke every `openswarm exec`/`run --path <absolute-path>` invocation. The package is ESM (`"type": "module"`) but `src/core/config.ts` lazily called CommonJS `require('node:path')` to import `resolve`. Hoisted `resolve` into the top-level `node:path` import. (#52, reported by @shuklatushar226)
- Fixed the same ESM-incompatible lazy `require('node:fs')` pattern in `src/automation/runnerState.ts` (`mkdirSync`), which would have crashed on the first daily-pace directory creation.

### Security

- Forced `protobufjs` to `^7.5.5` via `package.json` `overrides` to mitigate CVE-2026-41242 / GHSA-xq3m-2v4x-88gg (critical RCE via crafted protobuf descriptors). The vulnerable copy was pulled in transitively through `@xenova/transformers` → `onnxruntime-web` → `onnx-proto`. OpenSwarm itself loads only trusted HuggingFace models, but the override removes the dependency-tree exposure entirely.

## Unreleased

### Added

- Added a canonical OpenSwarm task-state store for hierarchy, dependencies, worktree ownership, and execution status.
- Added a Python/Pydantic mirror model for the canonical task-state schema.
- Added structured Linear state-sync comments for machine-readable issue snapshots.
- Added task-state rehydration from the latest Linear sync comment during autonomous fetch.

### Changed

- Planner decomposition now resolves child-task dependencies into canonical state instead of leaving them as description-only text.
- Dependent child issues are no longer all promoted immediately; only dependency-free children start runnable.
- Decomposed parent issues now stay active until all child issues complete, then close automatically.
