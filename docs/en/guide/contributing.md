# Contributing and Local Quality Gates

This guide explains how to install, develop, test, and run the local quality gates before opening a PR. The goal is to help maintainers and contributors answer one question before review: did this change break the core Coding Agent workflow?

## Setup

Install root dependencies with Bun:

```bash
bun install
```

If your change touches `desktop/`, also install desktop dependencies:

```bash
cd desktop
bun install
```

If your change touches `adapters/`, or if you run `check:adapters` / `check:native`, install adapter dependencies:

```bash
cd adapters
bun install
```

Do not commit local artifacts such as `artifacts/quality-runs/`, `node_modules/`, or `desktop/node_modules/`.

## Path-Aware PR Checks

First ask the repository which deterministic checks match the changed paths:

```bash
bun run check:impact
```

Run the selected focused commands while developing. Before claiming PR-ready, for a high-risk change, or when reproducing the full hosted CI locally, use the unified entrypoint:

```bash
bun run verify
```

`bun run verify` is equivalent to `bun run quality:pr`. It runs the selected policy, desktop, server, adapter, native, provider contract, chat contract, persistence, docs, and coverage lanes, without calling real models. Small external contributions do not need to run unrelated modules locally; GitHub CI runs the exact path-aware gate again.

The main quality report embeds the current test scope, result matrix, coverage summary, and links to the full coverage/JUnit/log artifacts:

```text
artifacts/quality-runs/<timestamp>/report.md
artifacts/quality-runs/<timestamp>/report.json
artifacts/quality-runs/<timestamp>/junit.xml
artifacts/quality-runs/<timestamp>/logs/*.log
artifacts/coverage/<timestamp>/coverage-report.md
artifacts/coverage/<timestamp>/coverage-report.json
```

Include the commands you ran and the report summary in your PR description. `quality:pr` / `quality:verify` remain available for contributors who prefer explicit quality command names, but docs and AI prompts should prefer `bun run verify`.

The coverage gate does four things: measures source-only coverage, enforces the baseline ratchet, reports target gaps against 75-80%+ maintained-area goals, and enforces changed-line coverage for new or modified executable production lines. The current baseline lives in `scripts/quality-gate/coverage-baseline.json`, and CI compares against the base branch baseline when available. New PRs must not lower coverage beyond the allowed window. Changes to `coverage-baseline.json` or `coverage-thresholds.json` require the maintainer-only `allow-coverage-baseline-change` label. Quarantine is reserved for maintainer baseline/release tracking and must never hide deterministic provider/chat contract tests; the normal PR gate does not depend on quarantine to pass.

## AI Coding Agent Fix Loop

When asking an AI coding agent to work in this repo, use this as the acceptance instruction:

```text
Run `bun run check:impact`, then run the selected focused checks. If the task
requires PR-ready/full validation, run `bun run verify`. If it fails, read the latest
`artifacts/quality-runs/<timestamp>/report.md` and the relevant lane log,
fix the missing tests, coverage failures, type/lint/build errors, or docs/native
failures, then rerun `bun run verify` until it passes. Do not lower coverage
baselines or thresholds unless a maintainer explicitly requested it.
```

Agents should handle failures in this order:

1. Start with the Summary and Result Matrix in `artifacts/quality-runs/<timestamp>/report.md` to identify the failing lane.
2. If `Path-aware PR checks` failed, check for missing same-area tests, CLI core changes, or coverage policy changes. Do not bypass normal feature PRs with maintainer overrides.
3. If `Coverage gate` failed, open `artifacts/coverage/<timestamp>/coverage-report.md` or `coverage-report.json`, then fix `changedLines.failures` and `failures` first. `targetGaps` are technical-debt signals; touched areas should still improve.
4. If desktop/server/adapters/native/docs failed, read `artifacts/quality-runs/<timestamp>/logs/<lane>.log`, add tests or fix the build, then rerun the narrow command.
5. After narrow checks pass, run `bun run verify` when claiming PR-ready/full validation. The agent may only make that claim when the final Summary has `failed=0`.

External reference points:

- [Google Testing Blog](https://testing.googleblog.com/2020/08/code-coverage-best-practices.html): 60% acceptable, 75% commendable, 90% exemplary; 90% is a reasonable lower threshold for changed/per-commit coverage.
- [Microsoft Visual Studio / Azure DevOps docs](https://learn.microsoft.com/en-us/visualstudio/test/using-code-coverage-to-determine-how-much-code-is-being-tested): teams typically target about 80%, typical project requirements can be 75%, and generated code may be relaxed.
- [ChromiumOS EC](https://chromium.googlesource.com/chromiumos/platform/ec/+/main/docs/code_coverage.md): new or changed lines require at least 80% coverage.

## Feature Quality Contract

Every feature, bugfix, and behavior change must ship with verifiable evidence. This rule applies to human authors and AI coding agents:

- Name the changed surface first: `desktop`, `server`, `adapter`, `native`, `docs`, `provider/runtime`, `agent-loop`, or `release`.
- Production changes under `desktop/src`, `src/server`, `src/tools`, `src/utils`, or `adapters` must include same-area tests in the same PR unless a maintainer explicitly applies `allow-missing-tests`.
- Pure logic needs unit tests. Server/API/provider/runtime behavior needs API or request-shape tests. Desktop UI/store/API behavior needs Vitest or Testing Library coverage. Cross-boundary user flows through UI, WebSocket, provider proxying, native sidecars, or release packaging need E2E or agent-browser smoke.
- Agent loop, tool execution, provider routing, model selection, file editing, permissions, session resume, and desktop chat changes need mock/fixture tests in PR, plus live smoke or baseline evidence when provider access is available.
- Coverage is part of the feature. This project follows a Google/Microsoft-style policy: generated/build output is not counted as product coverage, maintained product areas should move toward 75-80%+, and new or changed executable production lines must pass the changed-line coverage threshold in `coverage-thresholds.json`.
- Do not lower `coverage-baseline.json` or `coverage-thresholds.json` just to pass the gate; real baseline/threshold changes require `allow-coverage-baseline-change` and a reason. Legacy low-coverage areas are debt; new PRs must leave touched areas better than they found them.
- The PR description must record changed files, tests added, coverage report path, E2E/live report path or blocker, and remaining risk.

## Local Pre-Push Reminder

push no longer runs a local quality gate. Run checks manually when needed:

```bash
bun run quality:push
```

`bun run quality:push` reuses the PR gate impact, policy, and path-aware checks, but skips the expensive coverage lane by default; full coverage remains in `bun run verify`, `bun run quality:pr`, and CI.

You can still install the local pre-push hook, but it only prints a non-blocking reminder and never blocks `git push`:

```bash
bun run hooks:install
```

Maintainers with a trusted repository environment and model quota can run real provider smoke and desktop agent-browser smoke manually:

```bash
bun run quality:providers
bun run quality:smoke -- --provider-model minimax:main:minimax-main
```

To run the full live baseline, use:

```bash
bun run quality:gate --mode baseline --allow-live --provider-model minimax:main:minimax-main
```

## PR CI Merge Gate

`.github/workflows/pr-quality.yml` runs for PR `opened`, `synchronize`, `reopened`, `ready_for_review`, `labeled`, and `unlabeled` events. `scope-plan` installs no dependencies and only produces the stable impact plan. `policy-enforcement` installs the frozen dependency graph independently and runs policy, so a policy failure cannot swallow product-test results. Product jobs depend only on `scope-plan` and select desktop, server, adapter, native, provider contract, chat contract, persistence, docs, and coverage lanes by path. The final `pr-quality-gate` validates every result strictly: selected jobs must succeed, unselected jobs must be skipped, and cancelled or missing results cannot be mistaken for success.

Repository settings should protect `main` with GitHub branch protection / rulesets and require the `pr-quality-gate` status check. CODEOWNERS requires maintainer review for workflows, quality policy, and high-risk provider/WebSocket boundaries. The local hook only reminds; the PR gate is what blocks low-quality merges.

## Area-Specific Checks

Run the checks that match the files you changed:

```bash
bun run check:server      # Server API, WebSocket, providers, sessions, and related tests
bun run check:desktop     # Desktop lint, Vitest, and production build
bun run check:adapters    # IM adapter tests
bun run check:native      # Desktop sidecars, Electron host, and package-smoke checks
bun run check:provider-contract # Offline provider/runtime/proxy contract tests
bun run check:chat-contract     # WebSocket, session, and desktop chat-store contracts
bun run check:persistence-upgrade # Persistence migrations and old-fixture compatibility
bun run check:docs        # Isolated install, build, and validation for the site/ React docs
bun run check:quarantine  # Maintainer baseline/release quarantine audit
bun run check:coverage    # Root, desktop, and adapter coverage reports plus ratchet enforcement
```

Focused tests are the normal development loop. Run `bun run verify` locally when claiming PR-ready/full validation; hosted CI still executes every selected required lane.

Production code changes must include matching tests. Changes under `desktop/src/**`, `src/server/**`, `src/tools/**`, `src/utils/**`, or `adapters/**` without a same-area test file are blocked unless a maintainer applies `allow-missing-tests`. Coverage baseline/threshold changes are also blocked unless a maintainer applies `allow-coverage-baseline-change`.

## Live Model Baseline

`quality:baseline` runs real Coding Agent tasks: it starts the local server, creates isolated fixtures, asks a model through chat to fix code, runs tests, and saves transcripts, diffs, verification logs, and a report. It also runs provider live smoke: saved or active OpenAI-compatible providers validate connectivity, proxy conversion, and streaming proxy behavior; env-only provider smoke validates upstream connectivity and the transform pipeline.

The default baseline command does not call real models:

```bash
bun run quality:baseline
```

To actually call models, pass `--allow-live` and choose a local provider.

First list your local providers and copyable selectors:

```bash
bun run quality:providers
```

Example output:

```text
Saved providers:
  MiniMax
    selector: minimax
    main: MiniMax-M2.7-highspeed
      --provider-model minimax:main:minimax-main
```

Copy one of the listed values:

```bash
bun run quality:gate --mode baseline --allow-live --provider-model minimax:main:minimax-main
```

To run only provider smoke plus desktop agent-browser smoke, use:

```bash
bun run quality:smoke --provider-model minimax:main:minimax-main
```

You can run multiple models in one pass:

```bash
bun run quality:gate --mode baseline --allow-live \
  --provider-model codingplan:main:codingplan-main \
  --provider-model minimax:main:minimax-main
```

Provider selectors come from the providers saved in your local Desktop Settings > Providers page. Contributors do not need the maintainer's provider UUIDs or vendor accounts. They can add their own provider locally, run `bun run quality:providers`, and choose their own model.

If you do not have a saved provider, you can run one unsaved provider smoke with environment variables:

```bash
QUALITY_GATE_PROVIDER_BASE_URL=https://example.com \
QUALITY_GATE_PROVIDER_API_KEY=... \
QUALITY_GATE_PROVIDER_MODEL=model-id \
QUALITY_GATE_PROVIDER_API_FORMAT=openai_chat \
bun run quality:gate --mode baseline --allow-live
```

## When To Run The Baseline

After deterministic contract/E2E checks pass, a trusted maintainer should run the live baseline for changes touching:

- Desktop chat, session resume, WebSocket, or the CLI bridge
- Provider, model, or runtime selection
- Permissions, tool calls, file edits, and task execution
- agent-browser smoke, Computer Use, Skills, or MCP
- Release preparation or broad cross-module refactors

External PRs from forks do not receive repository secrets, and contributors are not expected to pay for model calls. Record `live model: not run (untrusted fork / no provider)` in the PR. A maintainer should add live evidence before merging or releasing high-risk changes; missing live evidence must not make deterministic PR lanes flaky.

## Release Gate

Before a release, run release mode:

```bash
bun run quality:gate --mode release --allow-live --provider-model <selector>:main
```

Release mode composes PR checks, baseline catalog validation, live baseline cases, provider smoke, native checks, and current-platform canonical release `package-smoke --package-kind release`. Reports are written to `artifacts/quality-runs/<timestamp>/`. The hosted release workflow now runs `bun run verify` as a non-live preflight before the packaging matrix; maintainers still need to run the live release gate explicitly with an available provider.

In release mode, live lanes are not allowed to be silently skipped. Missing providers, model quota, or external account access will fail the gate and must be recorded as a release blocker.

## PR Workflow

1. Create a product branch such as `fix/session-reconnect` or `feat/provider-quality-gate`.
2. Install dependencies and make the change.
3. Add tests for behavior changes.
4. Run focused checks for the affected area.
5. Optional: run `bun run hooks:install` to show a non-blocking reminder before later pushes.
6. Run `bun run verify` if you are claiming PR-ready/full validation.
7. A trusted maintainer runs the live baseline for high-risk changes; external contributors only record why it was not run.
8. In the PR description, include user impact, verification commands, coverage/quality report summary, and known risks.

## FAQ

### Can I run checks without a provider?

Yes. Run the impact report and its selected deterministic checks:

```bash
bun run check:impact
```

`bun run verify` also needs no real model. Only the live baseline does. Maintainers can add a provider in Desktop Settings > Providers, then run:

```bash
bun run quality:providers
```

### What if provider selectors conflict?

If two provider names produce the same selector, `quality:providers` falls back to the provider ID. Copy the `--provider-model ...` value it prints.

### What if a model ID contains a colon?

Prefer role selectors:

```bash
--provider-model custom:haiku:custom-haiku
```

The runner resolves `haiku` to the real model ID from your local provider configuration.
