# AI Coding Instructions

Follow the repository contract in `AGENTS.md` before editing code.

For every feature or bugfix:

- Identify the changed surface before coding: `desktop`, `server`, `adapter`, `native`, `docs`, `provider/runtime`, `agent-loop`, or `release`.
- Add same-area tests with the production change. Do not leave production behavior untested unless the PR explicitly carries the maintainer override `allow-missing-tests`.
- Preserve or improve the coverage ratchet. New or changed executable production lines must pass the changed-line coverage threshold in `scripts/quality-gate/coverage-thresholds.json`; do not edit coverage baselines or thresholds without maintainer approval via `allow-coverage-baseline-change`.
- Use unit tests for pure logic, API/request-shape tests for server/provider/runtime behavior, Testing Library/Vitest for desktop UI and stores, and E2E or agent-browser smoke for user-visible cross-boundary flows.
- For agent loop, tool execution, provider routing, model selection, file editing, permissions, session resume, and desktop chat changes, include mock/fixture tests and provide live smoke or baseline evidence when provider access is available.
- Before marking work complete, run the narrow relevant check and then `bun run verify`; for high-risk Coding Agent paths, also run `bun run quality:providers` plus the appropriate `quality:smoke`, `quality:baseline`, or `quality:release` command.
- In the final handoff or PR description, include changed files, tests added, coverage report path, E2E/live report path or blocker, and known residual risk.
