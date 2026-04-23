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

## Commit & Pull Request Guidelines
Recent history follows Conventional Commit prefixes such as `feat:`, `fix:`, and `docs:`. Keep subjects imperative and scoped to one change. PRs should explain the user-visible impact, list verification steps, link related issues, and include screenshots for desktop or docs UI changes. Keep diffs reviewable and call out any follow-up work or known gaps.
