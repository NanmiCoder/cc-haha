# Repository Instructions

This file is the entry point for coding agents. Keep it short: it should route an agent to the right code, tests, and deeper documentation rather than duplicate them.

Rules closer to the code take precedence. Before editing `.github/`, `src/`, `desktop/`, `adapters/`, or `docs/`, read the nested `AGENTS.md` in that directory.

## Start Here

- Run `git status --short` before editing. Preserve all existing user changes and never revert, restage, reformat, or overwrite unrelated work.
- Identify the affected surface and inspect its production path, nearest tests, and existing implementation pattern before proposing a change. Check recent history when regression context matters.
- For bugs, reproduce the failure or add a regression test that fails for the intended reason. If reproduction is impossible, state the limitation instead of guessing.
- Define the smallest behavior change and the proof that will demonstrate it. Stop and re-scope if the diff crosses an unplanned surface, adds a dependency, or grows beyond the verified seam.
- For broad investigation, parallel read-only subagents are encouraged. Give editing agents non-overlapping file ownership; the primary agent owns integration and final verification.
- Tool access is capability, not authorization. Do not create/switch branches, commit, push, open or merge a PR, publish a release, change repository settings, or spend live-provider quota unless the user explicitly requests that operation.

## Repository Map

- `src/`: CLI, Ink UI, commands, services, tools, shared runtime utilities, and the local API/WebSocket server.
- `desktop/`: React desktop UI, Electron host, native/sidecar resources, and desktop build scripts.
- `adapters/`: Telegram, Feishu, WeChat, DingTalk, and shared IM adapter utilities.
- `site/`: React documentation site and build tooling. `docs/` and `docs/en/` are its Chinese and English Markdown content sources; keep counterparts aligned when both exist.
- `.github/workflows/`, `scripts/pr/`, and `scripts/quality-gate/`: CI routing and quality policy.
- `release-notes/`, `scripts/release.ts`, and `.github/workflows/release-desktop.yml`: desktop release automation.

## Implementation Rules

- Make narrow, owned diffs. Every changed line must trace to the request, a failing test, or a verified compatibility constraint.
- Prefer existing utilities, stores, services, and test harnesses. Do not add dependencies or speculative abstractions unless the task requires them.
- Production changes under `src/`, `desktop/src/`, or `adapters/` require a same-area regression test unless a maintainer explicitly approves an exception.
- Keep TypeScript ESM style: 2-space indentation, no semicolons, `PascalCase` components, and `camelCase` functions/hooks/stores.
- Use structured parsers and existing boundaries instead of ad hoc string manipulation. Add comments only for non-obvious control flow or external constraints.
- Do not commit generated output such as `artifacts/`, coverage reports, `node_modules/`, build directories, or Rust `target/` trees.
- When publishing is explicitly requested, use Conventional Commit subjects and normal product branch prefixes such as `fix/`, `feat/`, or `docs/`; do not create `codex/` branches in this repository.

## Verification

1. Run the narrowest relevant test while iterating.
2. Run `bun run check:impact`; every command it selects is part of the minimum handoff for the current diff.
3. Run `bun run verify` only when full validation is requested or before claiming a code change is PR-ready or push-ready.

Additional invariants:

- Required PR checks must be deterministic and work on an untrusted fork: no real models, public network, repository secrets, saved providers, or real user home/config. Use fake credentials, fixtures, mocked/loopback transports, temporary directories, and explicit cleanup.
- Provider/auth/proxy/runtime changes may select `bun run check:provider-contract`; desktop chat/WebSocket/session changes may select `bun run check:chat-contract`. These contracts are offline and do not replace their selected surface checks.
- Any persisted JSON, `localStorage`, or app-config shape change requires a forward migration, an old-fixture regression test, and `bun run check:persistence-upgrade`.
- User-visible desktop or cross-process behavior needs an actual browser/desktop smoke path when unit tests cannot prove the workflow.
- Live model checks are separate maintainer evidence. Run them only after deterministic checks pass and a maintainer explicitly authorizes quota use; finding credentials on the machine is not authorization.
- `bun run check:docs` runs `npm ci`; run it sequentially with checks that rely on root `node_modules`.

## User-State Safety

- Never use or mutate the developer's real `~/.claude`, keychain, tokens, transcripts, providers, or project settings in tests. Redirect every relevant path to a temporary directory.
- Treat `~/.claude/settings.json` as user-owned shared state: preserve unknown fields, merge additively, and never add a repository-owned global schema marker.
- Repair/Doctor flows are deny-by-default. They may automatically change only explicitly allowlisted, regenerable desktop UI state; protected user data requires a reviewed, backup-first manual flow.

## Handoff

- Review `git diff --check`, `git diff`, and `git status --short` before reporting completion.
- Report only evidence from the current worktree: changed files, tests added, commands actually run and their observed results, checks not run, blockers, and remaining risk.
- `passed`, `failed`, `skipped`, `blocked`, and `not run` are different states. A build is not E2E, a mock is not live-provider evidence, and an older report becomes stale after relevant edits.

## Deeper Guides

- Contributor workflow and quality lanes: `CONTRIBUTING.md` and `docs/guide/contributing.md`
- Package scripts and path routing: `package.json` and `scripts/pr/change-policy.ts`
- PR evidence contract: `.github/pull_request_template.md`
- Desktop release and auto-update runbook: `docs/desktop/10-release-auto-update.md`
