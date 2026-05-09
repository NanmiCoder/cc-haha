## Summary


## Feature Quality Contract

- Changed surface: <!-- desktop / server / adapter / native / docs / provider-runtime / agent-loop / release -->
- Tests added or updated:
  - <!-- e.g. unit/component/API/request-shape/workflow/E2E -->
- Coverage evidence:
  - <!-- coverage report path + relevant suite summary + changed-line coverage -->
- E2E / live-model evidence:
  - <!-- command + report path, or explicit blocker such as no provider/quota -->
- Known risk / rollback:
  - <!-- remaining risk and how to revert safely -->

## Verification

- [ ] I ran the relevant local checks, or explained why they do not apply.
- [ ] I added or updated same-area tests for every production behavior change.
- [ ] I ran `bun run verify` for code changes, including the coverage gate.
- [ ] New or changed executable production lines meet the changed-line coverage threshold, or the blocker/maintainer override is documented.
- [ ] I attached or summarized the quality report path, JUnit/log artifact path, and pass/fail/skip counts.
- [ ] I ran E2E/live smoke for cross-boundary, provider/runtime, desktop chat, agent-loop, native, or release changes, or documented the blocker.

## Risk

- [ ] This PR does not touch CLI core paths, or it has maintainer approval for `allow-cli-core-change`.
- [ ] Production code changes include matching tests, or have maintainer approval for `allow-missing-tests`.
- [ ] Coverage baseline/threshold changes have maintainer approval for `allow-coverage-baseline-change`.
- [ ] Quarantined tests still have owners, exit criteria, and unexpired review windows.
- [ ] Provider/runtime changes were covered by mock contract tests, and live smoke was run or explicitly deferred.

@dosubot review this PR for changed-area risk, missing tests, docs impact, desktop startup risk, and CLI core impact.
