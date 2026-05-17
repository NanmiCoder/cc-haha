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

## Required PR Gate

Before opening a normal PR, contributors and AI coding agents should run the single entrypoint:

```bash
bun run verify
```

`bun run verify` is the one-command entrypoint and is equivalent to `bun run quality:pr`. This gate does not call real models, so every contributor can run it locally. It starts with an impact report, then actually runs the selected local gates for the changed paths: policy, desktop, server, adapters, native, docs, quarantine, and coverage. A non-zero exit means the branch is not ready for PR or push.

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

The coverage gate does four things: measures source-only coverage, enforces the baseline ratchet, reports target gaps against 75-80%+ maintained-area goals, and enforces changed-line coverage for new or modified executable production lines. The current baseline lives in `scripts/quality-gate/coverage-baseline.json`, and CI compares against the base branch baseline when available. New PRs must not lower coverage beyond the allowed window. Changes to `coverage-baseline.json` or `coverage-thresholds.json` require the maintainer-only `allow-coverage-baseline-change` label. Quarantine entries must keep an owner, reviewAfter date, and exit criteria; once reviewAfter expires, the default server and coverage gates fail until maintainers review the entry.

## AI Coding Agent Fix Loop

When asking an AI coding agent to work in this repo, use this as the acceptance instruction:

```text
Run `bun run verify`. If it fails, read the latest
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
5. After narrow checks pass, run `bun run verify` again. The agent may only claim ready when the final Summary has `failed=0`.

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

## Local Pre-Push Gate

Git hooks are local, so each clone needs to install the hook once:

```bash
bun run hooks:install
```

After installation, every `git push` runs the fast local gate internally (`bun run quality:push`). It reuses the PR gate impact, policy, and path-aware checks, but skips the expensive coverage lane by default; full coverage remains in `bun run verify`, `bun run quality:pr`, and CI. If unit tests, docs/native/adapter checks, or any other selected fast path-aware lane fails, the local hook blocks the push.

Maintainers or contributors with model quota can also add real provider smoke and desktop agent-browser smoke to the pre-push hook:

```bash
bun run quality:providers
bun run hooks:install -- --live-provider-model minimax:main:minimax-main
```

To run the full live baseline before every push, use:

```bash
bun run hooks:install -- --live-provider-model minimax:main:minimax-main --live-mode baseline
```

These options are stored in local `.git/config` as `quality.prePush*` keys, so provider selectors and secrets are not committed. `smoke` mode covers real provider connectivity plus the desktop UI chat smoke; `baseline` mode also runs every real Coding Agent baseline case.

Maintainer-level overrides must also be explicit local config before the hook passes them to `quality:push`:

```bash
bun run hooks:install -- --allow-cli-core-change --allow-coverage-baseline-change
```

This only affects the current clone and is not committed; PR CI still requires the matching labels.

## PR CI Merge Gate

`.github/workflows/pr-quality.yml` runs for PR `opened`, `synchronize`, `reopened`, `ready_for_review`, `labeled`, and `unlabeled` events. It starts with `change-policy`, which maps changed files to the desktop, server, adapter, native, docs, and coverage lanes. The final `pr-quality-gate` job aggregates every selected job: failed selected jobs fail `pr-quality-gate`, while unselected jobs may be skipped.

Repository settings should protect `main` with GitHub branch protection / rulesets and require the `pr-quality-gate` status check. The local hook blocks low-quality pushes; the PR gate blocks low-quality merges.

## Area-Specific Checks

Run the checks that match the files you changed:

```bash
bun run check:server      # Server API, WebSocket, providers, sessions, and related tests
bun run check:desktop     # Desktop lint, Vitest, and production build
bun run check:adapters    # IM adapter tests
bun run check:native      # Desktop sidecars and Tauri native checks
bun run check:docs        # Docs build, using npm ci + docs:build
bun run check:quarantine  # Quarantine owners, exit criteria, and review windows
bun run check:coverage    # Root, desktop, and adapter coverage reports plus ratchet enforcement
```

Focused tests are fine while developing, but run `bun run verify` before sending the PR.

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

Run the live baseline for changes touching:

- Desktop chat, session resume, WebSocket, or the CLI bridge
- Provider, model, or runtime selection
- Permissions, tool calls, file edits, and task execution
- agent-browser smoke, Computer Use, Skills, or MCP
- Release preparation or broad cross-module refactors

If you do not have model access, still run `bun run verify` and state in the PR why the live baseline was not run.

## Release Gate

Before a release, run release mode:

```bash
bun run quality:gate --mode release --allow-live --provider-model <selector>:main
```

Release mode composes PR checks, baseline catalog validation, live baseline cases, provider smoke, desktop smoke, and native checks. Reports are written to `artifacts/quality-runs/<timestamp>/`. The hosted release workflow now runs `quality:gate --mode pr` as a non-live preflight before the packaging matrix and uploads a `release-quality-gate` artifact; maintainers still need to run the live release gate explicitly with an available provider.

In release mode, live lanes are not allowed to be silently skipped. Missing providers, model quota, or external account access will fail the gate and must be recorded as a release blocker.

## PR Workflow

1. Create a product branch such as `fix/session-reconnect` or `feat/provider-quality-gate`.
2. Install dependencies and make the change.
3. Add tests for behavior changes.
4. Run focused checks for the affected area.
5. Optional but recommended: run `bun run hooks:install` so later pushes are blocked by failing gates.
6. Run `bun run verify`.
7. Run the live baseline for high-risk changes.
8. In the PR description, include user impact, verification commands, coverage/quality report summary, and known risks.

## FAQ

### Can I run checks without a provider?

Yes. Run the normal PR gate:

```bash
bun run verify
```

Only the live baseline needs a real model. Add your provider in Desktop Settings > Providers, then run:

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
