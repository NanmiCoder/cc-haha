# CI and Repository Policy

These rules apply to `.github/` changes in addition to the root instructions.

- Treat workflow changes as product changes. Run `bun run check:policy`; run `actionlint` when available.
- `scripts/pr/change-policy.ts` is the source of truth for path-to-check routing. Do not duplicate the routing graph in advisory automation.
- Routing is path prefixes plus the import graph from `scripts/pr/module-graph.ts`. Prefixes decide areas and every blocking rule; the graph only widens which surface checks run. When the graph cannot be built the run selects every surface rather than silently falling back to prefixes.
- `nightly-quality.yml` runs every deterministic lane unconditionally and re-proves the module graph. It exists because per-PR selection can only ever cover what a diff reaches; do not move its jobs into the required PR gate. It runs daily at 19:00 UTC and on `workflow_dispatch`; the maintainer chose that cadence, `pr-quality-workflow.test.ts` pins it, and changing it is the maintainer's call. Every job that runs runtime suites must install ripgrep first (also pinned there): agent discovery lists files through it.
- Keep `pr-quality-gate` as the stable required status. Selected jobs must succeed and unselected jobs must be explicitly skipped; never convert failures into success.
- Required PR jobs must remain offline and must not receive provider credentials or depend on paid/live services.
- A `pull_request_target` workflow may inspect PR metadata using trusted base code, but must never execute the PR head, install PR-controlled dependencies, or expose secrets to contributor code.
- Keep Bun aligned with `package.json#packageManager` and use frozen lockfile installs in required jobs.
- Do not weaken coverage, test routing, CODEOWNERS, or branch protections to make another change pass. Maintainer override labels require an explicit, documented decision.
- A PR authored by an individual CODEOWNER needs no `allow-cli-core-change` label (maintainer decision, 2026-10). Both `scope-plan` and `pr-triage.yml` read CODEOWNERS from the base branch, never the PR head. The other override labels are unchanged.
- Never retry a failed test into a pass. `check:server` re-runs each failed file once to label it `FLAKY` or `FAILED`, and still fails the gate either way; fix the race, or quarantine with a reason and owner only as a last resort.
- Repository settings, rulesets, secrets, and required-check changes require explicit user authorization; editing workflow files alone does not grant it.
