# Repository Guidelines

## Project Structure & Module Organization
The root package is the Bun-based CLI and local server. Main code lives in `src/`: `entrypoints/` for startup paths, `screens/` and `components/` for the Ink TUI, `commands/` for slash commands, `services/` for API/MCP/OAuth logic, and `tools/` for agent tool implementations. `bin/yuanclaw` is the executable entrypoint. The desktop app is isolated in `desktop/` with React UI code in `desktop/src/` and Tauri glue in `desktop/src-tauri/`. Documentation is in `docs/` and builds with VitePress. Treat root screenshots and `docs/images/` as reference assets, not source code.

## Build, Test, and Development Commands
Install root dependencies with `bun install`, then install desktop dependencies in `desktop/` if you are touching the app UI.

- `./bin/yuanclaw` or `bun run start`: run the CLI locally.
- `SERVER_PORT=3456 bun run src/server/index.ts`: start the local API/WebSocket server used by `desktop/`.
- `bun run docs:dev` / `bun run docs:build`: preview or build the VitePress docs.
- `cd desktop && bun run dev`: run the desktop frontend in Vite.
- `cd desktop && bun run build`: type-check and produce a production web build.
- `cd desktop && bun run test`: run Vitest suites.
- `cd desktop && bun run lint`: run TypeScript no-emit checks.
- `bun run quality:providers`: list configured provider/model selectors for live agent baselines.
- `bun run quality:pr`: run the local PR quality gate and write a report under `artifacts/quality-runs/`.
- `bun run quality:gate --mode baseline --allow-live --provider-model <provider:model[:label]>`: run live Coding Agent baseline cases, including desktop agent-browser smoke.
- `bun run quality:gate --mode release --allow-live --provider-model <provider:model[:label]>`: run the release gate with live baseline coverage.

## Desktop Release Workflow
- Desktop releases are built remotely by GitHub Actions, not by uploading local build artifacts.
- The release workflow is `.github/workflows/release-desktop.yml`; it triggers automatically on `push` of tags matching `v*.*.*`.
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
Desktop tests use Vitest with Testing Library in a `jsdom` environment. Name tests `*.test.ts` or `*.test.tsx`; colocate focused tests near the file or place broader coverage in `desktop/src/__tests__/`. No coverage gate is configured, so add regression tests for any behavior you change and run the relevant suites before opening a PR.

## Quality Gate Automation
Future Coding Agents should run the right local gate themselves before claiming a change is ready. Do not ask the user to manually run the commands unless credentials, local model access, or machine resources are missing.

- For normal code changes, run the narrow relevant check first, then `bun run quality:pr` before a PR-ready or merge-ready claim.
- Use `bun run check:server` for `src/server`, `src/tools`, provider/runtime, MCP, OAuth, WebSocket, or API behavior changes.
- Use `bun run check:desktop` for `desktop/src` UI, stores, API clients, and desktop web behavior changes.
- Use `bun run check:native` for `desktop/src-tauri`, sidecars, native packaging, release, or platform startup behavior changes.
- Use `bun run check:adapters` for `adapters/`; on a fresh checkout run `cd adapters && bun install` first if dependencies are missing.
- Use `bun run check:docs` for docs, VitePress, README, or docs workflow changes.
- For chat, agent loop, tool execution, provider routing, desktop chat UI, CLI task execution, or other core Coding Agent paths, also run a live baseline when local providers are available: first `bun run quality:providers`, then choose one or more copyable selectors and run `bun run quality:gate --mode baseline --allow-live --provider-model <provider:model[:label]>`.
- For release readiness, run `bun run quality:gate --mode release --allow-live --provider-model <provider:model[:label]>` with at least one real provider/model selector. Prefer multiple providers when quota is available.
- If no live provider is configured, or a provider quota/key is unavailable, run the non-live gate anyway and report the live-baseline blocker explicitly instead of claiming full release confidence.
- `bun run check:docs` executes `npm ci`, which can rebuild root `node_modules`. Run docs checks sequentially, not in parallel with `quality:pr`, `check:native`, or other commands that depend on the same installed packages.
- Quality reports are written to `artifacts/quality-runs/<timestamp>/`. Summarize the final report path and the pass/fail counts in handoffs and PR descriptions.
- Do not commit generated `artifacts/quality-runs/`, local `.omx/` state, `node_modules/`, `desktop/node_modules/`, or adapter dependency folders.
- Do not claim "complete", "ready to merge", or "ready to release" without either running the matching gate or naming the exact blocker that prevented it.

## Commit & Pull Request Guidelines
Recent history follows Conventional Commit prefixes such as `feat:`, `fix:`, and `docs:`. Keep subjects imperative and scoped to one change. PRs should explain the user-visible impact, list verification steps, link related issues, and include screenshots for desktop or docs UI changes. Keep diffs reviewable and call out any follow-up work or known gaps.
Branch names should use normal product prefixes such as `fix/xxx`, `feat/xxx`, or `docs/xxx`; do not create `codex/`-prefixed branches in this repository.
