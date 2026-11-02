# Adapter Reliability Conformance

Every platform adapter must satisfy the same ref/action contract. The tests are
written against `PlatformAdapter` semantics, so macOS AX, Windows UIA and Linux
AT-SPI share the same expectations.

The reusable command-path helper lives in `tests/conformance/ref_action_contract.rs`.
`window_identity_contract.rs` holds the window-identity contract, and
`macos_notification_contract.rs` the macOS-only notification contract. The
executable smoke harness in `src/tests/conformance.rs` mounts all three and runs
the ref/action helper against a mock adapter. A fixture driving a real adapter
can call the same helper with adapter-provided refs.

## Required Gates

| Area | Required behavior |
|------|-------------------|
| Snapshot refs | Refs are depth-first, snapshot-qualified (`@<snapshot_id>:eN`), and a bare `@eN` is rejected with `INVALID_ARGS` |
| Strict resolve | A ref resolves only when identity still matches; stale refs return `STALE_REF` |
| Ambiguity | Multiple plausible matches return `AMBIGUOUS_TARGET`, never an arbitrary click |
| Actionability | Ref actions check live visibility, stability, enabled state, supported action, policy, and editability before dispatch |
| Wait recovery | `wait --element` polls the snapshot embedded in its qualified ref, honors the caller timeout while resolving, and reports the last observed predicate state |
| Snapshot scope | A qualified ref resolves its own snapshot inside the selected session namespace and never searches other sessions |
| Trace | With a `trace: on` session manifest (from `session start`), commands write per-process JSONL segments under the session directory. `--trace <path>` overrides to one file. Best-effort unless `--trace-strict`. |
| Session lifecycle | `session start/end/list/gc` manage manifests, the current-session pointer, and trace directories |
| FFI parity | FFI ref actions use strict resolve and actionability checks before adapter dispatch |

## Platform Matrix

| Fixture | macOS AX | Windows UIA | Linux AT-SPI |
|---------|:--------:|:-----------:|:------------:|
| Two identical buttons produce ambiguity | Required | Required | Required |
| Ref disappears after snapshot | Required | Required | Required |
| Disabled button blocks click before dispatch | Required | Required | Required |
| Text field supports value/type actionability | Required | Required | Required |
| Session A latest refmap is invisible to Session B | Required | Required | Required |
| Batch item session overrides inherited session | Required | Required | Required |
| FFI `AdRefEntry` preserves full identity envelope | Required | Required | Required |

## Adding a Platform

Add adapter-specific integration fixtures, but keep expected errors and JSON
shapes identical. Prefer semantic platform actions first (`AXPress`, UIA
Invoke/Value/Selection patterns, AT-SPI actions). Coordinate input is a lower
confidence fallback and must remain explicit in policy or command choice.

## Windows Private-Storage Gate

Windows private-file behavior is verified by native tests, never by
cross-compilation evidence alone. The Windows CI lanes run these suites natively:

| Behavior | Native test |
|----------|-------------|
| A junction as a path component, the parent, or the leaf is refused and nothing lands at its target | `crates/windows/src/system/private_file/path_tests.rs` |
| A validated ancestor cannot be renamed while the write holds its no-follow handle | `a_pinned_directory_cannot_be_renamed_while_its_no_follow_handle_is_held` in `path_tests.rs` |
| A foreign owner is refused on atomic write, append, and bounded read | `owner_tests.rs` |
| A fresh artifact keeps its inherited SYSTEM, Administrators, and user grants, and never `BUILTIN\Users`, across create and replace | `a_profile_artifact_keeps_system_admins_and_user_and_never_users_across_create_and_replace` in `owner_tests.rs` |
| Remote or undeterminable storage refuses the write and append surfaces | `locality_tests.rs` |
| Atomic replace succeeds over open readers and concurrent writers, and leaves no temporary residue | `replace_tests.rs` |
| The binary and the FFI adapter install the hardened seam, and `session start` through a junction state root is refused with nothing written under the target | `src/tests/windows_private_file_install.rs`, `crates/ffi/tests/c_abi_windows_private_file_install.rs` |

The module protects each private directory it creates with a protected DACL
(`dacl::protect_directory`) granting SYSTEM, Administrators, the token user and
the owner-eligible SIDs, and `dacl::require_private` checks that DACL before use.
Files created in such a directory inherit those grants, which
`a_profile_artifact_keeps_system_admins_and_user_and_never_users_across_create_and_replace`
in `owner_tests.rs` pins.
