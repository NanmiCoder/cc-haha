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
- Production changes under `src/`, `desktop/src/`, or `adapters/` require a same-area regression test unless a maintainer explicitly approves an exception. A test that only covers the hop you just changed satisfies this rule and still lets the next change break — see "Writing a test that holds" below.
- Keep TypeScript ESM style: 2-space indentation, no semicolons, `PascalCase` components, and `camelCase` functions/hooks/stores.
- Use structured parsers and existing boundaries instead of ad hoc string manipulation. Add comments only for non-obvious control flow or external constraints.
- Do not commit generated output such as `artifacts/`, coverage reports, `node_modules/`, build directories, or Rust `target/` trees.
- When publishing is explicitly requested, use Conventional Commit subjects and normal product branch prefixes such as `fix/`, `feat/`, or `docs/`; do not create `codex/` branches in this repository.

## Writing a Test That Holds

Most regressions here are repairs of a recent repair: 21 of the last 70 `fix` commits
edit lines another `fix` wrote within 30 days. Coverage is not the missing signal —
`ContextUsageIndicator.tsx` sits at 87% branch coverage and was fixed three times in
ninety minutes. What those tests had in common is shape, so choose it deliberately.

- **Drive the transition; never hand-write the state it produces.** Component tests in
  `desktop/src` call `setState` 744 times and a real store action 3 times. State you
  assigned is self-consistent by construction and cannot expose "transition A did not
  update B" — which is where these bugs live. Use `handleServerMessage`, store actions,
  and real user events.
- **Assert the invariant, not today's output.** `2262973a4` shipped
  `expect(getByText('deepseek-reasoner'))` at a moment when the screen showed another
  model's number: it wrote the bug in as a passing assertion, and the next fix had to
  invert that exact line. Ask what must be true after this step, not what it prints now.
- **Cover both directions of any rule that drops or merges something.** The replay guard
  was tested for "a replay must be discarded" and never for "a genuine repeat must be
  kept", so it shipped dropping real replies.
- **Test the join, not each end.** Server, store, and component each had a test for
  `runtime_config_applied`; nothing crossed them, and deleting the term that joins them
  (`ChatInput.tsx` `refreshNonce`) left 314 tests green.
- **Never retune an existing test's inputs to keep it green.** `128f75ab5` changed five
  tests' props (`messageCount={0}` → `{1}`) instead of accepting that they described
  states a real session cannot reach. If a test only passes after you edit its inputs,
  the test was describing the implementation.
- **Do not mock the module under test.** A hand-written factory freezes an interface
  snapshot: the store can be renamed or gutted and the test still passes.
- **If you are comparing content to decide identity, the identity exists upstream.**
  Deduping by text cannot separate a replay from a legitimate repeat; forward the id
  (`uuid`, `toolUseId`) instead of guessing.

Blind spots to check rather than trust:

- `desktop/electron/` is not instrumented at all (`vitest.config.ts` collects only
  `desktop/src`), so main-process diffs score zero covered lines.
- Bun's LCOV emits no branch records, so `src/` and `adapters/` report **100% branch
  coverage** for data that was never collected (`pct(0, 0) === 100`). Only `desktop/`
  has real branch numbers.

## Verification

1. Run the narrowest relevant test while iterating.
2. Run `bun run check:impact`; every command it selects is part of the minimum handoff for the current diff. Selection is import-aware: a change is routed to every surface that imports it, not only to its own directory. The report's `## Cross-surface impact` section names the importer that pulled in each extra check.
3. Run `bun run verify` only when full validation is requested or before claiming a code change is PR-ready or push-ready.

Additional invariants:

- Required PR checks must be deterministic and work on an untrusted fork: no real models, public network, repository secrets, saved providers, or real user home/config. Use fake credentials, fixtures, mocked/loopback transports, temporary directories, and explicit cleanup.
- `bun run check:agent-flow` is the deterministic end-to-end agent lane: it drives the real server and WebSocket through session creation, runtime selection, streaming, tool permission allow/deny, tool failure, API error, interrupt, reconnect replay, and session recovery using the repository's mock SDK CLI. It needs no provider, credentials, or network, so every contributor can run it.
- `bun run check:desktop-ui-smoke` drives the real desktop UI against that same mock runtime and answers the permission dialog by clicking the real button. It skips with a printed reason when `agent-browser` or desktop dependencies are missing.
- Quality-gate lanes that boot the real server must run in a sandbox config dir (`scripts/quality-gate/sandbox.ts`) and fail if they wrote to the developer's real `~/.claude`.
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

- Contributor workflow and quality lanes: `CONTRIBUTING.md` and `docs/internals/contributing.md`
- Package scripts and path routing: `package.json` and `scripts/pr/change-policy.ts`
- PR evidence contract: `.github/pull_request_template.md`
- Desktop release and auto-update runbook: `docs/desktop/10-release-auto-update.md`
