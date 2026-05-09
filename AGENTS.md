# Repository Guidelines

## Project Structure & Module Organization
The root package is the Bun-based CLI and local server. Main code lives in `src/`: `entrypoints/` for startup paths, `screens/` and `components/` for the Ink TUI, `commands/` for slash commands, `services/` for API/MCP/OAuth logic, and `tools/` for agent tool implementations. `bin/claude-haha` is the executable entrypoint. The desktop app is isolated in `desktop/` with React UI code in `desktop/src/` and Tauri glue in `desktop/src-tauri/`. Documentation is in `docs/` and builds with VitePress. Treat root screenshots and `docs/images/` as reference assets, not source code.

## Build, Test, and Development Commands
Install root dependencies with `bun install`, then install desktop dependencies in `desktop/` if you are touching the app UI.

- `./bin/claude-haha` or `bun run start`: run the CLI locally.
- `SERVER_PORT=3456 bun run src/server/index.ts`: start the local API/WebSocket server used by `desktop/`.
- `bun run docs:dev` / `bun run docs:build`: preview or build the VitePress docs.
- `cd desktop && bun run dev`: run the desktop frontend in Vite.
- `cd desktop && bun run build`: type-check and produce a production web build.
- `cd desktop && bun run test`: run Vitest suites.
- `cd desktop && bun run lint`: run TypeScript no-emit checks.
- `bun run verify`: one-command local PR verification entrypoint for contributors and AI coding agents; equivalent to `bun run quality:pr`.
- `bun run quality:providers`: list configured provider/model selectors for live agent baselines.
- `bun run quality:pr`: run the local PR quality gate and write markdown, JSON, JUnit, and per-lane logs under `artifacts/quality-runs/`, plus coverage reports under `artifacts/coverage/`.
- `bun run check:quarantine`: validate quarantined tests still have owners, exit criteria, and active review windows.
- `bun run check:coverage`: run root, desktop, and adapter coverage suites with ratchet enforcement.
- `bun run quality:smoke --provider-model <provider:model[:label]>`: run only provider live/proxy smoke and desktop agent-browser smoke.
- `bun run quality:gate --mode baseline --allow-live --provider-model <provider:model[:label]>`: run live Coding Agent baseline cases, provider smoke, and desktop agent-browser smoke.
- `bun run quality:gate --mode release --allow-live --provider-model <provider:model[:label]>`: run the release gate with live baseline, provider smoke, desktop smoke, and coverage.

## Desktop Release Workflow
- Desktop releases are built remotely by GitHub Actions, not by uploading local build artifacts.
- The release workflow is `.github/workflows/release-desktop.yml`; it triggers automatically on `push` of tags matching `v*.*.*`.
- Release workflow builds wait on a non-live `quality:gate --mode pr` preflight and upload `release-quality-gate`; run the live release gate locally or in a maintainer-controlled environment when provider credentials are available.
- GitHub Release body is sourced from `release-notes/vX.Y.Z.md` in the tagged commit. Keep the filename aligned with the version/tag exactly.
- Use `bun run scripts/release.ts <version>` to cut a desktop release. The script updates version files, refreshes `desktop/src-tauri/Cargo.lock`, requires the matching `release-notes/vX.Y.Z.md`, commits it, and creates the annotated tag.
- The normal release push is `git push origin main --tags`. If the tag, app version, or release-notes filename do not match, the workflow is designed to fail fast instead of publishing the wrong release.
- For local macOS test packaging, `desktop/scripts/build-macos-arm64.sh` is the canonical Apple Silicon build entrypoint, and outputs land under `desktop/build-artifacts/macos-arm64/`.

## Docs Workflow Notes
- The docs workflow is `.github/workflows/deploy-docs.yml` and uses `npm ci`, not Bun. When root `package.json` dependencies change, keep `package-lock.json` in the same commit or the docs build will fail.
- The docs workflow currently runs on Node 22; avoid reintroducing older Node assumptions there without checking dependency engine requirements.

## Coding Style & Naming Conventions
Use TypeScript with 2-space indentation, ESM imports, and no semicolons to match the existing code. Prefer `PascalCase` for React components, `camelCase` for functions, hooks, and stores, and descriptive file names like `teamWatcher.ts` or `AgentTranscript.tsx`. Keep shared UI in `desktop/src/components/`, API clients in `desktop/src/api/`, and avoid adding new dependencies unless the existing utilities cannot cover the change.

## Testing Guidelines
Desktop tests use Vitest with Testing Library in a `jsdom` environment. Name tests `*.test.ts` or `*.test.tsx`; colocate focused tests near the file or place broader coverage in `desktop/src/__tests__/`. Add regression tests for behavior changes and keep the coverage ratchet from dropping.

## Persistent Storage Compatibility
- Any change to local JSON, `localStorage`, or app config persistence formats must ship with a forward migration, an old-fixture regression test, and a persistence upgrade gate.
- `~/.claude/settings.json` is user-owned shared state: preserve unknown fields on read/write, merge additively, and never write a repo-owned global `schemaVersion` into it.
- Desktop Doctor and any automatic repair path must be deny-by-default. One-click repair may only mutate allowlisted, regenerable desktop UI state such as `cc-haha-*` `localStorage` keys or native window state. It must never mutate chat transcripts, model/provider config, Skills, MCP config, plugin state, IM bindings, adapter sessions, OAuth tokens, or team/session records.
- Protected files include `~/.claude/projects/**/*.jsonl`, `~/.claude/settings.json`, project `.claude/settings.json`, `~/.claude/cc-haha/providers.json`, `~/.claude/cc-haha/settings.json`, `~/.claude/adapters.json`, `~/.claude/adapter-sessions.json`, `~/.claude/skills`, project `.claude/skills`, `.mcp.json`, managed MCP config, `~/.claude/plugins/**`, `~/.claude/teams/**`, and `~/.claude/cc-haha/*oauth*.json`. Doctor may diagnose these paths only with redaction unless a future task explicitly adds a reviewed, backup-first manual repair flow.
- If a persistence shape cannot be upgraded in place, the change is blocked until the upgrade path is explicit and tested.

## Feature Quality Contract
Every feature, bugfix, and behavior change must ship with proof that matches the changed surface. Treat this as the implementation contract for both human authors and AI coding agents.

- Start by naming the behavior surface: `desktop`, `server`, `adapter`, `native`, `docs`, `provider/runtime`, `agent-loop`, or `release`.
- Production code changes under `desktop/src`, `src/server`, `src/tools`, `src/utils`, or `adapters` must include a same-area test file in the same PR unless a maintainer explicitly approves `allow-missing-tests`.
- Pure logic requires unit tests. Server/API/provider/runtime changes require server or request-shape tests. Desktop UI/store/API changes require Vitest or Testing Library coverage. User-facing desktop flows require browser/agent-browser smoke when the flow cannot be trusted through unit tests alone.
- Agent loop, tool execution, provider routing, model selection, file editing, permissions, session resume, and desktop chat changes require mock/fixture tests in PR plus live smoke or baseline evidence from a maintainer machine when provider access exists.
- Coverage is part of the feature, not an afterthought. The project standard is modeled on Google/Microsoft-style coverage practice: generated/build output is excluded, maintained product areas should move toward 75-80%+, and every changed executable production line must meet the changed-line coverage gate in `scripts/quality-gate/coverage-thresholds.json` before push/PR readiness.
- Do not lower `scripts/quality-gate/coverage-baseline.json` or `coverage-thresholds.json` unless the PR carries maintainer approval via `allow-coverage-baseline-change` and explains why. Legacy areas below target are debt; new work must leave the touched area higher than it found it.
- E2E is required when the feature crosses process boundaries, browser UI, WebSocket/session state, provider proxying, native sidecars, or release packaging. Use the narrowest meaningful E2E lane first, then `quality:baseline`/`quality:release` for core Coding Agent paths.
- A PR is not ready until the author records changed files, tests added, coverage report path, E2E/live evidence or explicit blocker, and remaining risk. AI agents must include this evidence before saying "complete", "ready", or "mergeable".

## Quality Gate Automation
Future Coding Agents should run the right local gate themselves before claiming a change is ready. Do not ask the user to manually run the commands unless credentials, local model access, or machine resources are missing.

- Unified local entrypoint: `bun run verify`. This is the command AI coding agents should run before final handoff; it is equivalent to `bun run quality:pr`, does not call real models, and writes `artifacts/quality-runs/<timestamp>/report.md` plus `artifacts/coverage/<timestamp>/coverage-report.md`.
- If `bun run verify` fails, do not stop at reporting the failure. Read the latest quality report, identify the failed lane in the Result Matrix, open that lane log under `artifacts/quality-runs/<timestamp>/logs/<lane>.log`, fix the concrete missing tests, coverage failures, lint/type/build errors, docs errors, or native errors, then rerun the narrow check and finally rerun `bun run verify`.
- For coverage failures, read both `coverage-report.md` and `coverage-report.json`. Fix `changedLines.failures` and `failures` first; treat `targetGaps` as debt signals and make touched areas better. Do not lower `coverage-baseline.json` or `coverage-thresholds.json` unless a maintainer explicitly requested and approved that policy change.
- For `Path-aware PR checks` failures, add same-area tests for changed production files instead of bypassing the gate. Maintainer overrides such as `allow-missing-tests`, `allow-cli-core-change`, and `allow-coverage-baseline-change` are not valid for ordinary feature work.
- For normal code changes, run the narrow relevant check first, then `bun run verify` before a PR-ready or merge-ready claim.
- Use `bun run check:server` for `src/server`, `src/tools`, provider/runtime, MCP, OAuth, WebSocket, or API behavior changes.
- Use `bun run check:desktop` for `desktop/src` UI, stores, API clients, and desktop web behavior changes.
- Use `bun run check:native` for `desktop/src-tauri`, sidecars, native packaging, release, or platform startup behavior changes.
- Use `bun run check:adapters` for `adapters/`; on a fresh checkout run `cd adapters && bun install` first if dependencies are missing.
- Use `bun run check:docs` for docs, VitePress, README, or docs workflow changes.
- Use `bun run check:quarantine` and `bun run check:coverage` for code changes; production changes under `desktop/src`, `src/server`, `src/tools`, `src/utils`, or `adapters` must include same-area tests unless a maintainer explicitly approves `allow-missing-tests`. Coverage baseline or threshold changes require `allow-coverage-baseline-change`.
- For chat, agent loop, tool execution, provider routing, desktop chat UI, CLI task execution, or other core Coding Agent paths, also run a live baseline when local providers are available: first `bun run quality:providers`, then choose one or more copyable selectors and run `bun run quality:gate --mode baseline --allow-live --provider-model <provider:model[:label]>`.
- For release readiness, run `bun run quality:gate --mode release --allow-live --provider-model <provider:model[:label]>` with at least one real provider/model selector. Prefer multiple providers when quota is available. Release-mode live lanes must not be skipped silently.
- If no live provider is configured, or a provider quota/key is unavailable, run the non-live gate anyway and report the live-baseline blocker explicitly instead of claiming full release confidence.
- `bun run check:docs` executes `npm ci`, which can rebuild root `node_modules`. Run docs checks sequentially, not in parallel with `verify`, `quality:pr`, `check:native`, or other commands that depend on the same installed packages.
- Quality reports are written to `artifacts/quality-runs/<timestamp>/` as `report.md`, `report.json`, `junit.xml`, and `logs/*.log`; coverage reports are written to `artifacts/coverage/<timestamp>/`. Summarize the final report paths and the pass/fail/skip counts in handoffs and PR descriptions.
- Do not commit generated `artifacts/quality-runs/`, local `.omx/` state, `node_modules/`, `desktop/node_modules/`, or adapter dependency folders.
- Do not claim "complete", "ready to merge", or "ready to release" without either running the matching gate or naming the exact blocker that prevented it.

## Commit & Pull Request Guidelines
Recent history follows Conventional Commit prefixes such as `feat:`, `fix:`, and `docs:`. Keep subjects imperative and scoped to one change. PRs should explain the user-visible impact, list verification steps, link related issues, and include screenshots for desktop or docs UI changes. Keep diffs reviewable and call out any follow-up work or known gaps.
Branch names should use normal product prefixes such as `fix/xxx`, `feat/xxx`, or `docs/xxx`; do not create `codex/`-prefixed branches in this repository.
