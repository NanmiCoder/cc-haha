# PR #1672 Remediation Plan

**Repository:** `NanmiCoder/cc-haha`
**Pull request:** #1672 (`fix(desktop): restore workspace entry on new-session drafts`)
**Plan owner:** `yukitakasama`
**Status:** Planning only; this document does not implement the remediation.
**Prepared:** 2026-10-24 (Asia/Shanghai)

## 1. Priority summary

| Priority | ID | Classification | Must fix? | Summary | Owner | Target |
|---|---|---|---|---|---|---|
| P2 | R-01 | Correctness / navigation race | Yes | Complete session and workspace initialization in the background after a tab switch, without stealing focus from the user’s current tab. | `yukitakasama` | Target date TBD; recommended within 2 business days after approval |
| P2 | R-02 | Correctness / lost intent race | Yes | Retain a workspace action requested during session creation and execute it exactly once after materialization. | `yukitakasama` | Target date TBD; same delivery as R-01 |
| P2 | R-03 | Test coverage | Yes | Add deterministic regression tests for both races and exactly-once action execution. | `yukitakasama` | Target date TBD; same delivery as R-01/R-02 |
| — | R-04 | Optimization / improvement | No | Consider privacy-safe diagnostics only if an approved existing telemetry/logging mechanism is confirmed. | `yukitakasama` | TBD; defer unless existing instrumentation is approved |

No P0 or P1 issue was identified in the reviewed PR diff. The ratings reflect user-visible correctness impact and the absence of evidence of data loss, privilege escalation, or security exposure.


## 2. Scope and assumptions

### In scope

This plan covers only the two interaction defects identified during review of PR #1672:

1. A workspace action can finish after the user has switched to another tab, and the completion path can incorrectly activate the newly created session.
2. A workspace action requested while the draft is already creating a session can be lost because the workspace effect is gated by `isSubmitting` and the shared materialization path clears the pending request.

The remediation is limited to the draft-session materialization flow, workspace-request state, tab activation decisions, and focused regression tests around those flows.

### Explicit product decisions

- If the user switches to another tab while a workspace request is creating a session, creation and workspace initialization **must continue in the background**.
- The workspace action **must be retained and executed**, exactly once, after the session becomes available.
- Background completion **must not change the user’s current active tab**.
- This remediation must **not add a new tab-management capability** (for example, a new background-open API) unless separately authorized. The implementation should use existing tab/store behavior; if the existing APIs cannot satisfy the requirement, stop and request confirmation rather than expanding scope.
- The PR must remain a draft after the update; it must not be marked ready for review.

### Out of scope

- Reworking workspace behavior unrelated to draft materialization.
- Changing the session-creation API or server behavior.
- Adding a new tab-management API or changing general tab semantics without separate approval.
- Refactoring unrelated desktop components, persistence, authentication, providers, or chat transport.
- Fixing pre-existing test warnings or unrelated failures.
- Marking the pull request ready for review, merging it, or publishing a release.

### Preconditions and assumptions

- The current PR branch is `fix/1651-new-session-workspace-entry` and corresponds to PR #1672.
- Review evidence is based on `desktop/src/pages/EmptySession.tsx`, `desktop/src/stores/uiStore.ts`, the workspace store, and the PR’s focused tests.
- `materializeDraftSession()` remains the single-session-creation guard for the draft flow.
- Existing APIs can add/open the created session without requiring a new capability; exact API availability is **TBD** and must be verified before implementation.
- Verification must not use real providers, public network calls, user credentials, or real user state.


## 3. Detailed remediation items

| ID / Priority / Type | Issue description, impact, and evidence | Possible root cause | Remediation steps | Affected files / modules | Dependencies | Effort / Owner / Target completion | Acceptance criteria | Verification method | Rollback and monitoring |
|---|---|---|---|---|---|---|---|---|---|
| **R-01 / P2 / Must fix**<br>Correctness | While a workspace request awaits `materializeDraftSession()`, the user can switch to another tab. The completion path at `desktop/src/pages/EmptySession.tsx:753-759` unconditionally calls `setActiveView('code')` and `openTab(sessionId, ...)`, so the newly created session may take focus away from the tab the user selected. | The asynchronous creation path does not distinguish finishing initialization from activating the new session. Completion does not re-check the navigation context captured when the request started. | 1. Capture the originating draft revision and active-tab/navigation context when the workspace request begins.<br>2. Await session creation and complete workspace initialization regardless of the current tab.<br>3. Before activating the created session, re-check whether the originating draft is still the active user context.<br>4. If the user switched tabs, initialize the session/workspace in the background and do not activate it.<br>5. Use only existing tab/store behavior; do not add a new tab-management API without explicit authorization.<br>6. Keep stale draft/revision guards so a late response cannot affect a newer draft. | `desktop/src/pages/EmptySession.tsx`<br>`desktop/src/pages/EmptySession.test.tsx`<br>Possibly existing `desktop/src/stores/tabStore.ts` APIs, subject to verification. | Existing `materializeDraftSession()`, `useTabStore`, `useUIStore`, `useWorkspaceStore`, and session-creation mocks. Existing non-activating tab behavior is **TBD**. | Estimate: **0.5–1.0 engineering day**.<br>Owner: `yukitakasama`.<br>Target date: **TBD**; recommended within 2 business days after approval. | - Session creation completes after the user changes tabs.<br>- Workspace initialization completes for the created session.<br>- The user’s newly selected tab remains active after the async operation finishes.<br>- No new tab-management capability is introduced.<br>- A late response cannot activate or mutate a newer draft. | Add a deterministic delayed-create test: start a workspace request, switch the active tab before resolving creation, resolve it, then assert that the active tab is unchanged and the new session has the expected workspace state. Run focused desktop tests and `bun run check:impact`; run selected desktop checks. | Roll back only R-01 code/tests if a regression occurs; no data migration is expected. Monitor focused test failures and existing client error reporting, if available. Diagnostic availability and event names are **TBD**; do not invent telemetry as part of the core fix. |
| **R-02 / P2 / Must fix**<br>Correctness | If Run is already materializing a session, a subsequent workspace request can be ignored by the effect guard at `desktop/src/pages/EmptySession.tsx:740-744` because `isSubmitting` is true. The shared materialization path also clears `draftWorkspaceRequest` around `desktop/src/pages/EmptySession.tsx:615`, so the action may be silently lost. | Run submission and workspace controls have separate consumers for the same draft materialization lifecycle. The pending action is not tied to the in-flight creation result, and request cleanup is not coordinated with the consumer that must execute it. | 1. Keep the workspace request pending while materialization is in flight.<br>2. Ensure Run and workspace actions share the single session-creation result rather than creating competing sessions.<br>3. After materialization resolves, consume and execute the retained action exactly once against the created session.<br>4. Clear the request only after successful execution or a confirmed terminal failure; do not discard it merely because `isSubmitting` is true.<br>5. Apply the existing nonce/revision guards to stale requests.<br>6. Preserve the user’s original Run behavior while ensuring the workspace action is not lost. | `desktop/src/pages/EmptySession.tsx`<br>`desktop/src/stores/uiStore.ts`<br>`desktop/src/pages/EmptySession.test.tsx` | Existing `materializingRef`, `draftWorkspaceRequest`, `clearDraftWorkspaceRequest`, and workspace actions. No new tab-management capability without separate authorization. | Estimate: **0.5–1.0 engineering day**.<br>Owner: `yukitakasama`.<br>Target date: **TBD**; deliver with R-01. | - An action requested during Run/materialization is retained and executed exactly once once the created session is available.<br>- No duplicate session is created.<br>- A failed creation leaves the draft recoverable, consistent with current UX; retry semantics for the action are **TBD**.<br>- A stale request cannot affect a later draft revision.<br>- The PR remains a draft. | Add a deterministic deferred-`createSession` test: start Run, request a workspace action before resolving creation, resolve once, and assert one created session plus exactly one workspace transition. Also test failure and stale-revision paths. Run focused tests, `bun run check:impact`, and selected desktop checks. | Roll back the request-consumption change independently if it causes duplicate actions or session creation. Preserve existing failure feedback and draft state. Check test evidence for duplicate `createSession`, duplicate workspace tabs, and stale nonce consumption. Production monitoring capability is **TBD**. |
| **R-03 / P2 / Must fix**<br>Test coverage | Existing PR tests cover ordinary materialization, duplicate workspace clicks, and failed creation, but not the two identified interleavings: switching tabs during creation and requesting a workspace action during Run/materialization. | Tests focus on sequential behavior and do not control the async boundary with a deferred promise. | 1. Add tests for R-01 and R-02 using deferred promises and deterministic store state.<br>2. Assert focus behavior and background workspace state.<br>3. Assert exactly-once execution and no duplicate session creation.<br>4. Keep fixtures isolated; avoid real providers, network, or user state.<br>5. Run focused suites before broader impact checks. | `desktop/src/pages/EmptySession.test.tsx`; if needed, `desktop/src/components/layout/TabBar.test.tsx`. | Vitest/testing-library setup and existing mocks. | Estimate: **0.5 engineering day**.<br>Owner: `yukitakasama`.<br>Target date: **TBD**; same delivery as R-01/R-02. | Tests fail against the pre-remediation behavior for the intended reason and pass after remediation. They are deterministic and do not rely on timing sleeps or live services. | Run focused test files, then `bun run check:impact`. Record passed, failed, skipped, or blocked checks separately. | Revert tests only if they are demonstrably incorrect; do not remove tests to mask a product regression. Test failures are the primary signal unless an approved existing telemetry path is confirmed. |
| **R-04 / P2 / Optimization / improvement**<br>Optional | There is no confirmed evidence that production diagnostics identify stale or lost draft workspace requests. Diagnostics could help detection, but are not required to correct the defect. | Existing monitoring coverage is unknown. New instrumentation without an approved path could add noise or create privacy concerns. | 1. Inspect existing desktop logging/error-reporting conventions.<br>2. If an approved existing mechanism is available, add low-volume diagnostics for unexpected stale/duplicate request consumption only.<br>3. Never log prompt text, file contents, paths, credentials, tokens, or provider data.<br>4. Otherwise defer this item. | **TBD**, dependent on existing logging/telemetry modules. | Approval of the instrumentation path and privacy requirements is required. | Estimate: **0.25–0.5 engineering day** if existing infrastructure is reusable.<br>Owner: `yukitakasama`.<br>Target date: **TBD**; optional and after core fixes. | Any diagnostics contain no sensitive user content and do not alter control flow or timing-sensitive semantics. | Review logging tests and privacy constraints; verify no new network dependency is introduced. | Omit or revert independently if logging is unavailable, noisy, or unapproved. Monitoring remains test-based. |


## 4. Phased implementation plan

| Phase / milestone | Timing | Deliverables | Key risks | Mitigation |
|---|---|---|---|---|
| **Phase 0 — Confirm constraints and inspect existing APIs** | Before code changes; duration TBD | Verify the PR branch and inspect existing tab/session APIs to confirm background completion is possible without adding a tab-management capability. | Existing APIs may not support non-activating completion; adding an API would exceed the approved scope. | Stop and request separate authorization if the requirement cannot be met with existing capabilities. Do not expand scope silently. |
| **Phase 1 — Coordinate in-flight materialization and background completion** | Recommended 0.5–1 day after Phase 0; exact schedule TBD | R-01/R-02 implementation: retain the request, share the creation result, preserve draft/revision guards, and separate background initialization from activation. | Duplicate session creation, repeated action execution, or stale responses mutating a later draft. | Keep one in-flight creation guard/result, use nonce and revision checks, and make request cleanup conditional on the request actually consumed. |
| **Phase 2 — Add deterministic regression coverage** | Recommended 0.5 day after Phase 1; exact schedule TBD | R-03 tests for tab switching, Run/action interleaving, exactly-once execution, failure, and stale revision behavior. | Tests pass accidentally due to timing or fail due to unrelated global state. | Use deferred promises, explicit store resets, mocked APIs, and no sleeps or live services. Confirm intended pre-fix failures where practical. |
| **Phase 3 — Verify and update the draft PR** | Recommended 0.5–1 day after Phase 2; exact schedule TBD | Focused tests, `bun run check:impact`, selected desktop checks, diff review, and a PR #1672 update that remains in draft. | Environment-specific failures or accidental PR state changes. | Record passed/failed/skipped/blocked checks separately. Update only the intended PR branch and verify the PR remains draft. |
| **Phase 4 — Optional diagnostics decision** | After core verification; timing TBD | Decide whether R-04 is appropriate using existing logging infrastructure. | New telemetry could expose sensitive data or add noise. | Defer unless an approved existing mechanism and privacy-safe event design are confirmed. |


## 5. Questions and information to confirm

1. What target completion date should be recorded for `yukitakasama`? **TBD**
2. On session-creation failure, should the retained workspace action remain queued for retry, or be cleared after existing error feedback? **TBD**
3. Is there an approved existing desktop logging/telemetry mechanism for optional R-04 diagnostics, and what privacy restrictions apply? **TBD**
4. If existing tab/store APIs cannot complete the task in the background without changing the active tab, is separate authorization for a new capability available? Until explicitly approved, **do not add it**. **TBD**


## 6. Delivery constraints

- This plan does not implement the remediation.
- Do not mark PR #1672 ready for review.
- Do not create or change a tab-management capability without explicit authorization.
- Do not use live providers, public network calls, real credentials, or real user state in deterministic verification.
