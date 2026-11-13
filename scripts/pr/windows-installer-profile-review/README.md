# Explicit historical Windows profile review

This is inactive on ordinary pushes and PR synchronization. The source-integration
grant does not authorize Stage B, new accounts/profiles, released setup/uninstaller
execution, or the emergency account-disable operation.

After the coordinator reviews the exact committed integration and grants one
isolated invocation, the authenticated `NanmiCoder` **user** adds
`p1879b-<full current PR head SHA>` (47 characters) to original PR #1883. An Actions
`GITHUB_TOKEN` label update does not trigger this workflow. Do not add/remove/readd
the label, rerun jobs, or retry after failure without a new reviewed admission.
No label is created or applied by these files.

The separate `pull_request: labeled` workflow requires the original fork/branch,
main target, actor, exact SHA label, and attempt 1. It checks out that exact head.
Before downloading anything it checks complete workflow history and permits only
the first matching authorized activation by `run_number`, including failed or
cancelled first runs. Same-head concurrency is serialized without cancellation of
a running job. Pending-run replacement, fork approval, missing event data,
conflicts, missing history, expired/deleted artifacts, and API errors may prevent
any B execution; they never authorize an automatic retry.

`windows-installer-profile-review.ts` only claims, stages, and collects evidence.
It never invokes the native fixture or account APIs. It reuses immutable A run
43361834858/artifact 14008657574, including the original 195584-byte PE SHA256
`da7dfc9ffa9adbeb693736b79afaf78e9872a1df239b4e1e1eb6b377690c5cf8`.
The three raw CRLF source pins are checked independently from the current sources'
canonical LF hashes. There is no binary rebuild or source-change fallback.
The full v0.7.8 setup comes from immutable artifact 14007544990 of the same run,
then its complete 230611497 bytes and SHA256 are verified again.

The exact reviewed PowerShell scripts, JSON spec, and pins are normalized to UTF-8
LF without BOM and hash-checked before use. They correspond to frozen review
manifest `84d62f493f9201ce158894507dbf85e062123ec72d59391dd0fb31775509e310`.
Only the explicit admitted job supplies the scripts' mutation switches. Default
script calls remain read-only summaries. The caller token is present only in the
read-only artifact-claim/download steps; the launcher clears the native child's
environment and reconstructs its whitelist/private state.

The normal launcher owns the private Controller and its bounded native cleanup.
The only-disable helper is a separate serial Windows PowerShell step, after the
launcher step/process has ended and only after failure/cancellation. It separately
proves the original Controller is gone and binds the private ledger, runner,
run/owner/generation/spec, actual SID/SAM, full marker, and unchanged raw bytes. It
only sets the verified owned account's disabled flag while preserving other flags.
It never kills processes or unloads/deletes hives/profiles/accounts. Even verified
disable returns nonzero with cleanup failed and remaining state unknown. A forced
job cancellation/timeout may prevent this step from running. Neither VM disposal
nor a missing report counts as native cleanup success.

Only bounded original reports, ledger, logs and the four named JSON snapshots are
uploaded. No profile tree, subject inputs, setup binary, password, or inherited
environment is uploaded. Collection does not promote historical facts or convert
a failed/cancelled native step to success.

This workflow is separate from the unchanged required `pr-quality-gate`. A green
historical B job would still not prove transient mutation order, trusted replacement
removal equivalence, complete old-to-new upgrade, or the reporter's Windows10
scenario. Compatibility stays disabled and old exit 22 stays fatal. F1 remains
incomplete until its separate evidence/review conditions are met.
