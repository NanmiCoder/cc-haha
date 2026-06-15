# Repository Agent Contract

This file is the operating contract for AI coding agents and human contributors working in this repository. Treat it as executable guidance: inspect the real code, make narrow changes, verify the affected behavior, and leave a handoff that another maintainer can trust.

## Agent Operating Rules
- Work autonomously on clear, reversible tasks. Do not stop to ask whether to proceed with obvious next steps; ask only for destructive actions, missing authority, or genuinely branching product decisions.
- Start every task by identifying the changed surface: `desktop`, `server`, `adapter`, `native`, `docs`, `provider/runtime`, `agent-loop`, or `release`.
- Check `git status --short` before editing. The worktree may already contain user changes; never revert, overwrite, restage, or reformat unrelated files.
- Keep diffs small and owned. Stage or commit only files you intentionally changed for the current task.
- Prefer existing utilities, stores, services, command patterns, and test harnesses over new abstractions. Do not add dependencies unless the task explicitly requires them.
- For cleanup/refactor/deslop work, write the cleanup plan first, lock existing behavior with regression tests when it is not already protected, then make one smell-focused pass at a time.
- Do not commit generated artifacts: `artifacts/quality-runs/`, `artifacts/coverage/`, `.omx/`, `node_modules/`, `desktop/node_modules/`, `adapters/node_modules/`, `desktop/src-tauri/target/`, or local build outputs.

## Engineering Behavior Guardrails
These rules are adapted from Karpathy-style coding-agent guidelines. They bias toward caution and simplicity, but do not override the autonomy rule for clear, reversible work.

- Think before coding. State assumptions when they matter, surface tradeoffs once, and do not hide confusion. If the request has multiple materially different interpretations, clarify the branch before editing.
- Prefer the simplest working change. Do not add features beyond the request, speculative flexibility, single-use abstractions, or configurability that has no current caller.
- Keep changes surgical. Match existing style even when you would design it differently, and do not "improve" adjacent code, comments, formatting, or dead code unless it directly serves the task.
- Clean up only your own mess. Remove imports, variables, functions, files, and tests that your change made obsolete; mention unrelated dead code rather than deleting it.
- Every changed line should trace back to the user request, a failing test, a verified bug, or a required compatibility constraint.
- Define success criteria before implementation. For bugs, first identify or add the test/repro that fails; for refactors, know which checks prove behavior did not change; for features, map each step to a verification command or smoke path.
- If an implementation grows much larger than the problem, stop and simplify before continuing. A senior maintainer should be able to explain why the size and shape of the diff are necessary.

## Project Structure & Module Organization
This is a Bun-based Coding Agent product with a CLI, local server, desktop app, IM adapters, docs, and release automation.

- `bin/claude-haha` is the executable entrypoint; `bun run start` and `./bin/claude-haha` run the CLI locally.
- `src/` contains the CLI/runtime surface: `entrypoints/` for startup paths, `screens/` and `components/` for the Ink TUI, `commands/` for slash commands, `services/` for API/MCP/OAuth logic, `tools/` for agent tools, `utils/` for shared runtime helpers, and `server/` for the local API/WebSocket service.
- `desktop/` contains the desktop product: React UI in `desktop/src/`, API clients in `desktop/src/api/`, shared UI in `desktop/src/components/`, Electron host code in `desktop/electron/`, legacy Tauri resources/sidecar assets in `desktop/src-tauri/`, and desktop build scripts in `desktop/scripts/`.
- `adapters/` contains IM adapter sidecars for Telegram, Feishu, WeChat, DingTalk, and shared adapter utilities.
- `docs/` and `docs/en/` are VitePress documentation. Root screenshots and `docs/images/` are reference assets unless a task explicitly updates docs media.
- `release-notes/`, `scripts/release.ts`, and `.github/workflows/` define release and CI behavior. Treat workflow changes as product changes because they alter what future agents and contributors can safely ship.

## Build, Test, and Development Commands
Install root dependencies with `bun install`. Install desktop dependencies in `desktop/` when touching desktop UI/native code, and adapter dependencies in `adapters/` when touching IM adapters.

- `./bin/claude-haha` or `bun run start`: run the CLI locally.
- `SERVER_PORT=3456 bun run src/server/index.ts`: start the local API/WebSocket server used by `desktop/`.
- `cd desktop && bun run dev`: run the desktop frontend in Vite.
- `cd desktop && bun run build`: type-check and produce a production web build.
- `cd desktop && bun run test`: run desktop Vitest suites.
- `cd desktop && bun run lint`: run desktop TypeScript no-emit checks.
- `cd adapters && bun run test`: run all adapter tests; use `test:telegram`, `test:feishu`, `test:wechat`, or `test:dingtalk` for focused adapter work.
- `bun run docs:dev` / `bun run docs:build`: preview or build the VitePress docs.
- `bun run check:impact`: print the changed-area impact report and recommended local checks.

## Verification Routing
Use the narrowest meaningful verification while iterating, then run the correct gate for the actual handoff level. Do not run long gates after every small edit. In normal local-development handoff, prefer focused regression tests plus the single affected surface gate. Reserve `bun run verify`, `bun run check:coverage`, and other full quality gates for PR-ready, push/merge, release, explicitly requested full validation, or genuinely high-risk changes.

If a user asks for a small fix, local explanation, or quick iteration, do not silently escalate to full PR verification. State the targeted checks you ran and, if relevant, say that full `verify`/coverage was intentionally not run because the change is not being called PR-ready. If a full gate was started and the user asks to stop or says it is too expensive, stop it and continue with scoped verification.

| Situation | Command | Notes |
| --- | --- | --- |
| Fast inner loop for pure logic | Focused `bun test <file>` or nearest package test | Add/update the regression test first when behavior changes. |
| Small scoped bugfix or local dev-flow fix | Focused regression test(s), then the narrowest affected surface gate if needed | Example: a CORS helper plus desktop bootstrap test should run those focused tests; add `check:server`/`check:desktop` only when the touched surface or handoff needs broader confidence. Do not run `verify`/coverage by default. |
| Desktop UI/store/API work | `bun run check:desktop` | Runs desktop lint, Vitest, and production build. For visible UI flows, also use browser/agent-browser smoke when unit tests cannot prove the workflow. |
| Server/API/provider/runtime/MCP/OAuth/WebSocket work | `bun run check:server` | Covers `src/server`, `src/tools`, provider/runtime, MCP, OAuth, WebSocket, and API behavior. |
| IM adapter work | `bun run check:adapters` | On a fresh checkout, run `cd adapters && bun install` first if dependencies are missing. |
| Electron/native/sidecar/packaging/version changes | `bun run check:native` | Runs sidecar build, Electron host checks, Electron `--dir` packaging, and current-platform package-smoke. |
| Docs, README, release notes, or docs workflow changes | `bun run check:docs` | This runs `npm ci`; run it sequentially, not in parallel with commands that depend on root `node_modules`. |
| Persistence shape changes | `bun run check:persistence-upgrade` | Required for local JSON, `localStorage`, app config migrations, and old-fixture upgrade behavior. |
| PR-ready coverage | `bun run check:coverage` or `bun run verify` | Required before calling a change PR-ready, push-ready, mergeable, or release-ready. Not required for ordinary local handoff unless the user asks for PR-level proof or the changed surface is high-risk. |
| Optional fast local check | `bun run quality:push` | Path-aware PR mode with coverage skipped by default; run manually when useful, not as a push-time blocker or substitute for PR-ready verification. |
| PR-ready / push-ready / full validation handoff for code changes | `bun run verify` | Unified local entrypoint: `bun run verify` is equivalent to `bun run quality:pr`. Run it only when claiming PR-ready, push-ready, mergeable, or when the user explicitly asks for full validation. |
| Live agent/provider confidence | `bun run quality:providers`, then `bun run quality:smoke --provider-model <provider:model[:label]>` | Quick live provider/proxy and desktop agent-browser smoke when provider access exists. |
| High-risk pre-merge confidence | `bun run quality:gate --mode baseline --allow-live --provider-model <provider:model[:label]>` | Use for agent-loop, provider routing, model selection, tool execution, session resume, desktop chat, or other core Coding Agent paths. |
| Release readiness | `bun run quality:gate --mode release --allow-live --provider-model <provider:model[:label]>` | Required before calling a release ready when provider credentials/quota are available. If blocked, report the exact live-provider blocker. |

If `bun run verify` is intentionally run and fails, do not stop at reporting the failure. Read the latest quality report, identify the failed lane in the Result Matrix, open the lane log under `artifacts/quality-runs/<timestamp>/logs/<lane>.log`, fix the concrete issue, rerun the narrow check, then rerun `bun run verify` only when the user still wants PR-level validation.

## Feature Quality Contract
Every feature, bugfix, and behavior change must ship with proof that matches the changed surface. Treat this as the implementation contract for both human authors and AI coding agents.

- Start by naming the behavior surface: `desktop`, `server`, `adapter`, `native`, `docs`, `provider/runtime`, `agent-loop`, or `release`.
- Production code changes under `desktop/src`, `src/server`, `src/tools`, `src/utils`, or `adapters` must include a same-area test file in the same PR unless a maintainer explicitly approves `allow-missing-tests`.
- Pure logic requires unit tests. Server/API/provider/runtime changes require server or request-shape tests. Desktop UI/store/API changes require Vitest or Testing Library coverage. User-facing desktop flows require browser/agent-browser smoke when the flow cannot be trusted through unit tests alone.
- Agent loop, tool execution, provider routing, model selection, file editing, permissions, session resume, and desktop chat changes require mock/fixture tests in PR plus live smoke or baseline evidence from a maintainer machine when provider access exists.
- Coverage is part of PR readiness, not an afterthought. Generated/build output is excluded, maintained product areas should move toward 75-80%+, and every changed executable production line must meet the changed-line coverage gate in `scripts/quality-gate/coverage-thresholds.json` before push/PR readiness. For local non-PR handoff, focused regression tests are acceptable; record that coverage was not run instead of running it by default.
- Do not lower `scripts/quality-gate/coverage-baseline.json` or `coverage-thresholds.json` unless the PR carries maintainer approval via `allow-coverage-baseline-change` and explains why. Legacy areas below target are debt; new work must leave the touched area higher than it found it.
- E2E is required when the feature crosses process boundaries, browser UI, WebSocket/session state, provider proxying, native sidecars, or release packaging. Use the narrowest meaningful E2E lane first, then `quality:baseline` or `quality:release` for core Coding Agent paths.
- A PR is not ready until the author records changed files, tests added, coverage report path, E2E/live evidence or explicit blocker, and remaining risk. AI agents must include this evidence before saying "PR-ready", "push-ready", "mergeable", or "release-ready". For ordinary local handoff, include changed files, targeted tests/checks run, tests not run, and remaining risk without escalating to PR-level gates.

## Persistent Storage Compatibility
- Any change to local JSON, `localStorage`, or app config persistence formats must ship with a forward migration, an old-fixture regression test, and a persistence upgrade gate.
- Run `bun run check:persistence-upgrade` for storage-shape changes. The change is blocked until migration tests, old fixtures, backup behavior, and unknown-field preservation pass.
- `~/.claude/settings.json` is user-owned shared state: preserve unknown fields on read/write, merge additively, and never write a repo-owned global `schemaVersion` into it.
- Desktop Doctor and any automatic repair path must be deny-by-default. One-click repair may only mutate allowlisted, regenerable desktop UI state such as `cc-haha-*` `localStorage` keys or native window state.
- Doctor and repair flows must never mutate chat transcripts, model/provider config, Skills, MCP config, plugin state, IM bindings, adapter sessions, OAuth tokens, or team/session records unless a future task explicitly adds a reviewed, backup-first manual repair flow.
- Protected files include `~/.claude/projects/**/*.jsonl`, `~/.claude/settings.json`, project `.claude/settings.json`, `~/.claude/cc-haha/providers.json`, `~/.claude/cc-haha/settings.json`, `~/.claude/adapters.json`, `~/.claude/adapter-sessions.json`, `~/.claude/skills`, project `.claude/skills`, `.mcp.json`, managed MCP config, `~/.claude/plugins/**`, `~/.claude/teams/**`, and `~/.claude/cc-haha/*oauth*.json`. Diagnose these paths only with redaction by default.
- If a persistence shape cannot be upgraded in place, the implementation is blocked until the upgrade path is explicit and tested.

## Desktop & UX Expectations
- Match the existing desktop design system and component patterns before adding new UI primitives.
- Use `lucide-react` icons for common actions when an icon exists. Use familiar controls: icon buttons for tool actions, toggles/checkboxes for binary settings, tabs for views, menus for option sets, and sliders/inputs for numeric values.
- Keep operational desktop UI dense, readable, and work-focused. Avoid marketing-style hero layouts, decorative cards, gradient-orb backgrounds, and oversized type inside app panels.
- Text must fit in its container on mobile and desktop viewports. Stable controls such as tab bars, toolbars, status chips, and buttons should not resize or shift when labels, hover states, or loading text change.
- For visible UI changes, validate with an actual browser/desktop smoke path when feasible and include screenshots or a short visual-evidence note in the handoff.

## Release Workflow
- Desktop releases are built remotely by GitHub Actions from tags matching `v*.*.*`; do not upload local build artifacts as the release source of truth.
- The release workflow `.github/workflows/release-desktop.yml` runs a non-live PR-quality preflight, validates that the tag matches `desktop/package.json`, loads `release-notes/vX.Y.Z.md`, builds sidecars, and packages the Electron desktop app across the matrix.
- The hosted tag workflow is not a substitute for local release verification. Before tagging or calling a release ready, run `bun run scripts/release.ts <version> --dry`, then run `bun run verify`, and run `bun run quality:gate --mode release --allow-live --provider-model <provider:model[:label]>` when live provider access is available.
- GitHub Release body is sourced from `release-notes/vX.Y.Z.md` in the tagged commit. Keep the filename, app version, and tag aligned exactly.
- Use `bun run scripts/release.ts <version>` to cut a desktop release. The script updates Electron desktop version files, requires the matching release-notes file, commits it, and creates the annotated tag.
- The normal release push is `git push origin main --tags`. If no live provider is configured, or a provider quota/key is unavailable, run the non-live gate anyway and report the live-release blocker explicitly.
- For local macOS test packaging, `desktop/scripts/build-macos-arm64.sh` is the canonical Apple Silicon build entrypoint, with outputs under `desktop/build-artifacts/macos-arm64/`.

## Docs Workflow Notes
- The docs workflow `.github/workflows/deploy-docs.yml` uses `npm ci`, not Bun. When root `package.json` dependencies change, keep `package-lock.json` in the same commit or the docs build will fail.
- The docs workflow currently runs on Node 22. Avoid reintroducing older Node assumptions without checking dependency engine requirements.
- Because `bun run check:docs` can rebuild root `node_modules`, run docs checks sequentially rather than in parallel with `verify`, `quality:pr`, `check:native`, or other commands that rely on the same dependency tree.

## Coding Style & Naming Conventions
- Use TypeScript with 2-space indentation, ESM imports, and no semicolons.
- Prefer `PascalCase` for React components, `camelCase` for functions/hooks/stores, and descriptive file names such as `teamWatcher.ts` or `AgentTranscript.tsx`.
- Keep shared desktop UI in `desktop/src/components/`, desktop API clients in `desktop/src/api/`, server behavior under `src/server/`, and agent/runtime utilities under `src/tools/` or `src/utils/` according to existing boundaries.
- For structured data, use structured parsers or existing helpers instead of ad hoc string manipulation.
- Add succinct comments only where they clarify non-obvious control flow or external constraints.

## Commit & Pull Request Guidelines
- Recent history follows Conventional Commit prefixes such as `feat:`, `fix:`, and `docs:`. Keep the subject imperative and scoped to one change.
- Branch names should use normal product prefixes such as `fix/xxx`, `feat/xxx`, or `docs/xxx`; do not create `codex/`-prefixed branches in this repository.
- When creating commits, use a Conventional Commit subject plus a useful body when the decision needs context. Prefer git-native trailers for durable decision notes:
  - `Constraint:` for external constraints.
  - `Rejected:` for alternatives considered and why they were not used.
  - `Confidence:` as `low`, `medium`, or `high`.
  - `Scope-risk:` as `narrow`, `moderate`, or `broad`.
  - `Directive:` for forward-looking warnings.
  - `Tested:` and `Not-tested:` for verification evidence and gaps.
- PRs should explain user-visible impact, link related issues, list verification steps, include screenshots for desktop/docs UI changes, and call out follow-up work or known gaps.
- A PR description must include changed files, tests added or updated, coverage report path, E2E/live evidence or blocker, pass/fail/skip counts from the quality report when available, and remaining risk/rollback notes. A normal local agent handoff may be lighter: summarize changed files, focused tests/checks run, skipped full gates, and remaining risk/rollback notes.
