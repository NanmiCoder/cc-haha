# Contributing Guide

Before opening a PR, identify what your change affects and run the matching deterministic checks. External contributors do not need a real model account or quota.

## 1. Run local checks based on impact

```bash
bun run check:impact
```

`check:impact` lists the checks selected for this change. For ordinary tasks, run those checks; when you're ready to declare the PR ready or need full verification, run the unified entry point directly, without first repeating all of its checks individually:

```bash
bun run verify
```

`bun run verify` runs the policy, product, contract, persistence, and coverage lanes selected by the changed paths, but never calls a real model. Small contributions don't need to rerun every unrelated module locally; the GitHub PR gate runs again and strictly checks the selected / skipped status.

While fixing, rerun the narrow affected checks; at handoff, provide verification evidence for the final diff. If there are no further changes or unresolved risks, checks that already passed don't need to be rerun.

`git push` no longer runs the local quality gate automatically. When you need quality checks, run `bun run quality:push` or `bun run verify` manually; `bun run verify` remains the source of truth for full coverage.

When you've only changed one module, use a narrow command to iterate quickly:

| Change scope | Quick check |
| --- | --- |
| CLI / Server / tools | `bun run check:server` |
| Desktop | `bun run check:desktop` |
| IM Adapter | `bun run check:adapters` |
| Desktop Electron / native packaging | `bun run check:native` |
| Provider / runtime / proxy | `bun run check:provider-contract` |
| Desktop chat / WebSocket / sessions | `bun run check:chat-contract` |
| Persistence formats and migrations | `bun run check:persistence-upgrade` |
| Docs | `bun run check:docs` |

When a gate fails, check the latest quality report and the matching lane log:

```
artifacts/quality-runs/<timestamp>/report.md
artifacts/quality-runs/<timestamp>/logs/<lane>.log
```

## 2. User-visible or cross-process desktop changes need manual testing

When a change touches user-visible UI, cross-WebSocket/cross-process flows, the Electron host, or native/packaging, verify the affected flows on a real machine in addition to the automated gates. Pure styling, pure tooling, or changes fully proven by existing component unit tests don't require repeating unrelated flows:

- Prefer `bun run check:desktop-ui-smoke` with its isolated mock runtime to verify the real desktop UI
- When you need to start the server and desktop app manually, reuse the temporary config and test environment from `scripts/quality-gate/sandbox.ts` so the server doesn't read or write your real `~/.claude`; use the `ego-browser` skill for ad-hoc browser work
- Verify the interaction flows the change touches: page rendering, button/form behavior, dialogs, keyboard shortcuts, multiple windows, etc.
- When needed, build a local macOS package with `desktop/scripts/build-macos-arm64.sh` for full verification

## 3. PRs must include impact and testing notes

Every PR description must include:

- **Impact**: which modules changed (desktop / server / adapter / native / docs / provider / agent-loop)
- **Testing**: which tests you ran, coverage status, and which flows you tested manually (user-visible or cross-process desktop changes need a real-device record)
- **Remaining risk**: known uncovered edge cases or points that need follow-up

Core paths such as provider/runtime, agent-loop, file editing, permissions, and sessions must first pass offline mock/fixture/contract tests. Real-model verification is run only by maintainers with trusted secrets and quota, before high-risk merges or releases:

```bash
bun run quality:providers
bun run quality:smoke --provider-model <provider:model>
```

PRs from forks don't receive repository secrets and should not be asked to run real models. Contributors only need to state `live model: not run (untrusted fork / no provider)` in the PR; this is not a reason for the deterministic PR gate to fail.

## Licensing boundaries for contributions

Before contributing, read the [LICENSE](LICENSE) and the [licensing notes](LICENSING.md). When submitting a new contribution, please explicitly agree to provide the new portions you have the right to license under the current cc-haha Community Source License 1.0. If you want to use a different license, state so clearly in the PR, and a maintainer will confirm before merging. This note does not retroactively change existing MIT contributions, nor does it transfer copyright or grant maintainers unrestricted relicensing rights.

When introducing or modifying third-party code, keep the original license and copyright notices and state the source. Do not change existing third-party licenses to the project's current license.

## More

See the [contributing guide](docs/internals/contributing.md) for the full quality gates and coverage notes; `AGENTS.md` only keeps high-signal entry points and routing for Agents.
