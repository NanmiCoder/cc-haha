# AI Coding Instructions

Follow the root `AGENTS.md` and the nearest nested `AGENTS.md` for the files you edit.

Use the root completion and authorization boundaries; consult `docs/internals/contributing.md` for task-specific testing and failure diagnosis. Continue scoped local implementation, deterministic checks, and fixes without asking at each step.

- Add same-area tests with the production change as defined by `scripts/pr/change-policy.ts`. Preserve or improve the coverage ratchet and meet the changed-line coverage threshold; maintainer overrides remain explicit decisions.
- Use E2E or desktop UI smoke when unit tests cannot prove a user-visible cross-boundary flow. Ad-hoc browser automation uses `ego-browser`; committed smoke scripts retain their own runner.
- Provider/auth/runtime-env/model-window/proxy changes require offline `bun run check:provider-contract` when selected by `check:impact`; desktop chat/WebSocket/session changes likewise use `check:chat-contract`.
- Live smoke is trusted-maintainer evidence only and requires explicit authorization. Required tests use isolated fixtures and no saved credentials.
- Follow the root verification policy once for the final diff. In the handoff, include changed files, tests added, commands actually run with pass/fail counts when available, checks not run, evidence paths when generated, and remaining risk.
