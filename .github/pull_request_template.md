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
- [ ] I ran the checks selected by `bun run check:impact`; if I claim PR-ready/full validation, I also ran `bun run verify`.
- [ ] New or changed executable production lines meet the changed-line coverage threshold, or the blocker/maintainer override is documented.
- [ ] I attached or summarized the quality report path, JUnit/log artifact path, and pass/fail/skip counts.
- [ ] I ran deterministic E2E/contract checks for cross-boundary changes. Live-model evidence is attached when a trusted maintainer ran it, otherwise it is explicitly marked not run.

## Risk

- [ ] This PR does not touch CLI core paths, is authored by a CODEOWNER, or has maintainer approval for `allow-cli-core-change`.
- [ ] Production code changes include matching tests, or have maintainer approval for `allow-missing-tests`.
- [ ] Coverage baseline/threshold changes have maintainer approval for `allow-coverage-baseline-change`.
- [ ] Any quarantine-policy change has maintainer approval; deterministic provider/chat contract tests were not quarantined.
- [ ] Provider/runtime changes are covered by offline mock/fixture contract tests; live smoke was run by a trusted maintainer or explicitly deferred.
