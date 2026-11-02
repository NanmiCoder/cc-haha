# Windows live E2E harness

PowerShell 5.1, no Python, no POSIX shell. Drives the real, staged, hashed
`agent-desktop.exe` against the real WinForms fixture (`tests/fixture-app-windows`)
and asserts every effect by independent re-observation, never by a command's
own `ok:true`.

## Modules

| File | Owns |
|---|---|
| `NativeTypes.psm1` | The Win32 P/Invoke type surface (structs, DllImport declarations) loaded once via `Add-Type`. |
| `Native.psm1` | File/handle/job-object/token-SID primitives built on `NativeTypes.psm1`. |
| `NativeDesktop.psm1` | Raw foreground-window/cursor/GUI-thread reads, also built on `NativeTypes.psm1`. |
| `BoundedProcess.psm1` | `Invoke-BoundedProcess` - job-object-bounded child spawn with a wall-clock deadline and a captured-output byte cap. |
| `Harness.psm1` | Isolated environment (`HOME`/`TEMP`/`CARGO_TARGET_DIR` redirection), recoverable delete, immutable binary staging + hash re-verification, fixture process identity, and `ConvertFrom-AgentJson`. |
| `DesktopLease.psm1` | The desktop-exclusivity lease and its CI adoption protocol, and the two guarded spawn entry points (`Invoke-Guarded`, `Invoke-GuardedAgent`). |
| `Lib.psm1` | Target objects that always carry their snapshot (`Find-Target`, `Get-Target`, `Test-Target`, `Wait-Target`, `Invoke-Target`), the independent-observation assertions (`Assert-Effect`, `Assert-NoEffect`, `Assert-Envelope`), lock ordering (`Enter-Stage`), and the verdict/skip ledger (`Register-Legs`, `Add-Pass`/`Add-Fail`/`Add-Skip`, `Write-Verdict`). |
| `NativeToken.psm1` | Process-token and integrity-level reads. |
| `StagedProcess.psm1` | Staged-process spawn and own-handle reporting helpers. |
| `StagedProcessHandleStability.psm1` | Handle-count stability checks for staged processes. |
| `LibEnvelope.psm1` | Envelope, batch and occluder assertions re-exported by `Lib.psm1`. |
| `LibVerdict.psm1` | Lock ordering, the leg ledger and `Require-Target`, re-exported by `Lib.psm1`. |
| `LibShell.psm1` | Shell-surface helpers used by the shell scenarios. |
| `ChromiumNative.psm1` | Native reads for the Chromium scenario. |
| `ChromiumStage.psm1` | Chromium content staging. |
| `CursorOverlaySupport.psm1` | Support helpers for the cursor-overlay scenario. |
| `Run-E2E.ps1` | The one process-terminating call in the whole tree. Scenario files (`scenarios/*.ps1`) return; only this script exits. |
| `scenarios/*.ps1` | One scenario per file, dot-sourced and run by `Run-E2E.ps1` in this order: Preconditions, Observation, NonInterference, Interaction, Acceptance, Reliability, Surfaces, ShellSurfaces, TracePerformance, Chromium, SplitIntegrity, CursorOverlay. Nothing is auto-discovered: a scenario file that `Run-E2E.ps1` does not dot-source and list in `Invoke-ScenarioSequence` never runs. |
| `AcceptanceContendedFocus.ps1`, `InteractionHeaded.ps1`, `InteractionPress.ps1`, `InteractionScroll.ps1` | Legs dot-sourced by `scenarios/Acceptance.ps1` and `scenarios/Interaction.ps1`. They sit outside `scenarios/` because the contract gate treats every file there as a top-level scenario entry point. |
| `selftest/` | Self-tests for the harness itself (see Running). |

Every file stays under the 400-line cap that `scripts/check-e2e-windows-contract.ps1` enforces (rule 13), so large modules and self-tests are split by responsibility: each `selftest/Invoke-*SelfTests.ps1` entry point owns the process exit and dot-sources its `*SelfTestCases*.ps1` files.

## Data files

- `skip-allowlist.psd1` - every capability token a scenario may pass to
  `Add-Skip`, with a reason. An undeclared token fails the run (a skip must
  never read as a pass).
- `latency-baseline.psd1` - the committed p99 store. `Initialize-NoEffectWindow`
  checks the pinned `Assert-NoEffect` window against it: the run refuses to start
  when that window is below 1.5x the largest recorded p99. It holds four
  whole-CLI cost entries taken from
  `probes/windows/24-fixture-e2e/captures/cost-baseline-devbox.json`; no
  per-leg entries have been measured, and `BootstrapP99Ms` applies only while
  `Legs` is empty.
- `fixture-inventory.psd1` - the `Resident` and `Staged` `AutomationId`s the
  fixture must expose. The Preconditions scenario compares it in both
  directions with the manifest the fixture writes
  (`tests/fixture-app-windows/README.md`).

## Running

```powershell
# Lib.psm1 self-tests (targets, assertions, lock ordering, verdict ledger), run
# against Stub-AgentDesktop.ps1: no desktop, no fixture, no staged binary.
# CI runs them through scripts\check-e2e-windows-contract.ps1 -SelfTest.
powershell -NoProfile -File tests\e2e-windows\selftest\Invoke-U7SelfTests.ps1

# Harness-core self-tests (isolation, immutable staging, bounded spawn, lease
# adoption): needs a real desktop and a built target\release\agent-desktop.exe
# (or -AgentDesktopBinary <path>); acquires the real desktop lease, so it
# cannot run on a hosted runner.
powershell -NoProfile -File tests\e2e-windows\selftest\Invoke-U6SelfTests.ps1

# The seeded-failure entry path (proves a failing leg reaches a non-zero
# process exit code, run on the hosted CI lane on every PR):
powershell -NoProfile -File tests\e2e-windows\Run-E2E.ps1 -SelfTestSeedFailure

# The live suite (local box only - acquires the desktop-exclusivity lease).
# Build both artifacts first; -AgentDesktopBinary and -FixtureBinary override
# the default paths target\release\agent-desktop.exe and
# tests\fixture-app-windows\build\AgentDeskFixture.exe.
cargo build --locked --release -p agent-desktop
powershell -NoProfile -File tests\fixture-app-windows\build.ps1
powershell -NoProfile -File tests\e2e-windows\Run-E2E.ps1
```

`scripts\run-windows-e2e-ci.ps1` is the operator entry point that does all of
that under one desktop lease: it builds the release binary and the fixture, runs
the cursor-overlay teardown tests and frame budgets, the harness-core
self-tests, and then `Run-E2E.ps1`. It refuses to run off Windows or without
`AGENT_DESKTOP_NATIVE_E2E_RUNNER=1`. No CI workflow runs the suite; the refusal
self-test in `ci.yml` runs it only to prove that guard exits 2.

## Conventions a scenario file must follow

- Every ref is a target object from `Find-Target`/`Find-TargetById`, carrying
  both `RefId` and `SnapshotId`. No helper accepts or returns a bare `@eN`.
- Effect assertions go through `Assert-Effect`/`Assert-NoEffect`; envelope
  assertions go through `Assert-Envelope`. Only `Lib.psm1` and `LibEnvelope.psm1` may use
  dotted access to `.ok`/`.error`/`.disposition`/`.data` on a command result
  (rule 5 gates dotted member access only; bracket indexing is not gated).
- Every desktop-touching leg is lexically wrapped in `Enter-Stage`, declaring
  locks in the fixed order `DesktopLease` -> `ForegroundStage` -> `MenuStage`.
- Every scenario calls `Register-Legs` with its leg names up front; every
  registered leg ends the run with a disposition (`Add-Pass`/`Add-Fail`/
  `Add-Skip`).
