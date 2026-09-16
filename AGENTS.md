# Repository Instructions

This is a routing guide for coding agents. Keep shared instructions model-independent; put task-specific detail next to the code or in the linked guides.

Rules closer to the code take precedence. For the directory you are changing, read the nested `AGENTS.md` in that directory and any applicable ancestors. Load other documentation when the task needs it.

## Start Here

- Run `git status --short` before editing and preserve existing user changes.
- Carry the requested outcome through implementation, relevant verification, and repair of failures caused by the change. Local edits and deterministic checks using disposable fixtures are authorized within that scope; do not stop for approval after the first implementation or each test run.
- Investigate the affected behavior and its callers. Follow a fix across boundaries when needed to complete the request; ask only when a material product decision or action outside the authorized scope is required.
- Use subagents for independent investigations or non-overlapping implementation work when useful. Give each a concrete question or file ownership and expected evidence; the primary agent owns integration and final verification.
- Tool access is capability, not authorization. Do not create/switch branches, commit, push, open or merge a PR, publish a release, change repository settings, or spend live-provider quota unless the user explicitly requests that operation. Authorization already given in the conversation remains valid.

## Repository Map

| Surface | Entry point |
| --- | --- |
| CLI, tools, runtime, local API/WebSocket server | [src/AGENTS.md](src/AGENTS.md) |
| React desktop UI, Electron host, native/sidecars | [desktop/AGENTS.md](desktop/AGENTS.md) |
| IM platforms and shared chat runtime | [adapters/AGENTS.md](adapters/AGENTS.md) |
| Chinese and English product/source documentation | [docs/AGENTS.md](docs/AGENTS.md) |
| React documentation site and build tooling | [site/AGENTS.md](site/AGENTS.md) |
| CI and quality policy | [.github/AGENTS.md](.github/AGENTS.md), `scripts/pr/`, `scripts/quality-gate/` |
| Desktop releases and auto-update | `release-notes/`, `scripts/release.ts`, [release guide](docs/internals/contributing.md#发版与自动更新) |

## Implementation Rules

- Keep changes tied to the requested behavior. Reuse existing utilities, stores, services, and test harnesses; add dependencies or abstractions only when the task needs them.
- Computer Use has one app-authorization boundary on both macOS and Windows: enabling it in Settings and confirming its consent dialog authorizes all apps. Do not add per-app prompts, allowlists, denylists, category-based access tiers, or host/helper exceptions after that consent. Global disablement, OS permissions, and target/process validity checks still apply.
- Executable JS/TS production changes under `src/`, `desktop/src/`, or `adapters/` require a same-area regression test unless a maintainer explicitly approves an exception. For bugs, reproduce the failure or add a test that fails for the intended reason; report when reproduction is unavailable. Test the behavior and affected boundaries. See [test design](docs/internals/contributing.md#回归测试设计) for state transitions, replay, and coverage caveats.
- Keep TypeScript ESM style: 2-space indentation, no semicolons, `PascalCase` components, and `camelCase` functions/hooks/stores. Use structured parsers and existing boundaries for structured data.
- Do not commit generated output such as `artifacts/`, coverage reports, `node_modules/`, build directories, or Rust `target/` trees.
- When publishing is explicitly requested, use Conventional Commit subjects and product branch prefixes such as `fix/`, `feat/`, or `docs/`; do not create `codex/` branches in this repository.

## Verification

- `bun run check:impact` selects the required checks using paths and imports. Run the selected checks for the final diff; use focused tests while fixing failures. `package.json` and `scripts/pr/change-policy.ts` are the command and routing sources of truth.
- Use `bun run verify` when full validation is requested or before claiming a code change is PR-ready or push-ready. It runs the selected PR lanes, so there is no need to run every lane separately first. Reuse passing results for unchanged code; rerun or broaden checks when subsequent edits, failures, or unresolved risks warrant it.
- Required PR checks must be deterministic: no real models, public network, repository secrets, saved providers, or real user home/config. Use fake credentials, fixtures, mocked/loopback transports, temporary directories, and cleanup. Server-booting quality lanes use `scripts/quality-gate/sandbox.ts` and must fail on real user-state writes.
- For user-visible desktop or cross-process changes that unit tests cannot prove, exercise a browser/desktop smoke path. Ad-hoc browser work uses the `ego-browser` skill; `agent-browser` is reserved for the committed smoke lane and `desktop/scripts/e2e-*-agent-browser.sh`. See the [deterministic agent/UI lanes](docs/internals/contributing.md#无模型的端到端-agent-门禁).
- Live model checks are separate maintainer evidence after deterministic checks pass and quota use is explicitly authorized; finding credentials on the machine is not authorization.

## User-State Safety

- Never use or mutate the developer's real `~/.claude`, keychain, tokens, transcripts, providers, or project settings in tests. Redirect every relevant path to a temporary directory.
- Treat `~/.claude/settings.json` as user-owned shared state: preserve unknown fields, merge additively, and never add a repository-owned global schema marker.
- Any persisted JSON, `localStorage`, or app-config shape change requires a forward migration, an old-fixture regression test, and `bun run check:persistence-upgrade`.
- Repair/Doctor flows are deny-by-default. Automatic repair may change only explicitly allowlisted, regenerable desktop UI state; protected user data requires a reviewed, backup-first manual flow.

## Handoff

- Review `git diff --check`, `git diff`, and `git status --short` before reporting completion.
- Report changed files, tests added, commands actually run and their observed results, checks not run, blockers, and remaining risk. Distinguish `passed`, `failed`, `skipped`, `blocked`, and `not run`; build-only, mock, live, and stale evidence are not interchangeable.
- Contributor workflow, failure diagnosis, and instruction maintenance: [CONTRIBUTING.md](CONTRIBUTING.md) and [detailed guide](docs/internals/contributing.md). PR evidence: [.github/pull_request_template.md](.github/pull_request_template.md).
