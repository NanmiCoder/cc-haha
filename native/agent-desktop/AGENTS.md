# AGENTS.md

Guidance for AI coding agents working in this repository.

agent-desktop is a tool that AI agents invoke, not an agent. It is a Rust CLI and C library that reads native
accessibility trees and returns structured JSON with ref-based element ids. The observe-act loop lives in the
calling agent. It never embeds an LLM and has no GUI or interactive prompt. It does not automate web pages (use
agent-browser). It cannot see UIs that expose no accessibility tree.

## Commands

Each platform adapter compiles only on its own OS and the workspace names all three, so an unscoped `cargo build`,
`cargo test --workspace` or `cargo clippy --all-targets` fails on every host. Scope cargo to the host's package set,
the same set `.githooks/pre-commit` uses:

```bash
HOST_PKGS=(-p agent-desktop-core -p agent-desktop-macos -p agent-desktop -p agent-desktop-ffi)
# Windows: replace agent-desktop-macos with agent-desktop-windows. Linux: with agent-desktop-linux.
# An array expands to separate arguments in both bash and zsh; a plain string does not in zsh.

cargo build "${HOST_PKGS[@]}"                                  # debug build
cargo build --release -p agent-desktop                         # release CLI; CI fails it above 15 MB
cargo test "${HOST_PKGS[@]}"                                   # every test target
cargo test "${HOST_PKGS[@]}" --lib                             # library tests only; skips the binary crate
cargo test -p agent-desktop                                    # binary crate: CLI contract, dispatch, batch, policy
cargo test "${HOST_PKGS[@]}" <test_name>                       # one test by name
cargo clippy "${HOST_PKGS[@]}" --all-targets -- -D warnings    # zero warnings
cargo fmt --all -- --check
cargo check -p agent-desktop-core --all-targets --target x86_64-pc-windows-msvc   # core cross-compiles
cargo check -p agent-desktop-core --all-targets --target x86_64-unknown-linux-gnu
cargo tree -p agent-desktop-core                               # must name no platform crate
AGENT_DESKTOP_E2E_EXCLUSIVE=1 bash tests/e2e/run.sh            # macOS E2E; builds its own artifacts
bash scripts/perf-baseline-compare.sh                          # macOS perf A/B against the merge-base
```

`scripts/cargo-test-isolated-home.sh test "${HOST_PKGS[@]}" --lib` runs tests with a throwaway `HOME`, which keeps them out
of your real `~/.agent-desktop`. The pre-commit hook uses it.

Enable the hook once per clone with `git config core.hooksPath .githooks`. For staged Rust or TOML changes it runs the
source-rule scripts (`check-rust-file-size.sh`, `check-no-phase-references.sh`, `check-stale-ref-constructor-misuse.sh`),
fmt, clippy and library tests over the host set. FFI changes add the C ABI passthrough test and the cbindgen header
check. Bypass it only in an emergency: `git commit --no-verify` or `SKIP_PRECOMMIT=1 git commit ...`.

## Where the truth lives

- **Shipped behavior** is the code and its tests. A doc that contradicts the code is a defect; fix it in the same change.
- **Agent usage** is the skills under `skills/`. They compile into the binary: `agent-desktop skills get desktop` and
  `agent-desktop skills get platform`.
- **Vocabulary** is `CONCEPTS.md`. **The JSON contract** is `docs/json-output.md`. **Past lessons** are in
  `docs/solutions/`, with YAML frontmatter (`module`, `tags`, `problem_type`); search it before you work in a
  documented area.
- **User docs** live in `apps/docs` and are served at agent-browser.dev/desktop. Use the `technical-writer` skill
  (`.agents/skills/technical-writer/SKILL.md`) when you write or edit prose: docs pages, READMEs, skills, changelog
  entries, commit messages, PR descriptions, and issues. The docs serve developers and the agents that call
  agent-desktop, so keep them complete, short, and checked against the code.
- **Planning documents** (the phase roadmap `phases.md`, sub-phase plans, brainstorms) live in `.compound-engineering/`
  at the repo root. That folder is untracked on purpose. Read it when you plan. Never link to it or cite it from a
  committed file, because it does not exist in any other checkout.
- When a plan contradicts the code, the code says what shipped. Correct the plan in place, with no "previously said"
  note, and cite what disproved it: a `probes/**/FINDINGS.md` row id or the source line.

### Build it; do not defer it

- The implementer makes the work land. "Harder than expected", "the PR is already large" and "a later phase touches
  this" are not reasons to defer.
- Defer only when the work is blocked: impossible on the platform, dependent on infrastructure that does not exist,
  or possible only by breaking a stated invariant or safety property. Name which one.
- Measure before you defer. Settle an unknown with a probe; a deferral that rests on an assumption is a guess.
- Reducing scope is the owner's call. If the work cannot land, say so and stop. Never narrow it quietly.
- Write each deferral into the receiving phase of the local roadmap before the PR opens, with the evidence that
  forced it, and name it in the PR description. If it changes what the current phase delivers, correct that phase too.

## Branches and commits

- `main` carries macOS, Windows and Linux. Fixes and features branch off `main` and merge back as squash merges;
  `main` requires linear history.
- Never add `Co-Authored-By` lines, AI attribution or "Generated with" footers.
- Use Conventional Commits: `feat:`, `fix:`, `feat!:` or a `BREAKING CHANGE:` footer, `docs:`, `style:`, `refactor:`,
  `perf:`, `chore:`, `ci:`, `test:`. Write `type: imperative summary` in lowercase after the colon, and say why.
- Versions follow semver from 1.0.0. A release is one PR that bumps the workspace version in `Cargo.toml`,
  `Cargo.lock`, `npm/package.json` and `CHANGELOG.md`. Merging it starts `.github/workflows/release.yml`, which
  publishes npm and the GitHub release; `docs/releasing.md` has the steps.

## Architecture

```
crates/core/     agent-desktop-core: PlatformAdapter trait in adapter/, shared types in domain folders,
                 one file per command in commands/
crates/macos/    agent-desktop-macos: AX API
crates/windows/  agent-desktop-windows: UI Automation
crates/linux/    agent-desktop-linux: AT-SPI
crates/ffi/      agent-desktop-ffi: cdylib and the committed C header include/agent_desktop.h
src/             agent-desktop binary: cli/, cli_args/, dispatch/, batch/, command_policy/, command_host/,
                 diagnostic/, visual_debug/
skills/          agent skills, compiled into the binary
tests/           golden fixtures, E2E harness per OS, FFI smoke tests
probes/          raw platform measurements; FINDINGS.md rows are citable evidence
apps/docs/       Geistdocs site served at agent-browser.dev/desktop as a Vercel Microfrontends child app
```

**Dependency inversion (non-negotiable).**
- Core defines `PlatformAdapter` and every shared type. Platform crates implement the trait.
- Core never imports a platform crate, and platform crates never import each other. CI fails if
  `cargo tree -p agent-desktop-core` names a platform crate.
- Only two crates wire a platform to core: the binary (`src/`) and the FFI crate.
- The platform is chosen at compile time by `#[cfg(target_os)]` in `build_adapter()` (`src/main.rs`,
  `crates/ffi/src/adapter.rs`) with target-gated dependencies in `src/Cargo.toml`
  (`[target.'cfg(target_os = "macos")'.dependencies]`), never unconditional dependencies behind source `cfg`s.
- `PlatformAdapter` is split across `crates/core/src/adapter/` (`mod.rs` plus the `actions`, `input`, `observation` and
  `system` fragments). Every method defaults to `AdapterError::not_supported`, so an adapter implements only what it
  supports. Strict resolution (`resolve_element_strict*`) returns `STALE_REF` for zero matches and `AMBIGUOUS_TARGET`
  for two or more.
- Core must run on every OS. A `#[cfg]` branch in core that no CI lane executes is a hypothesis, not shipped code: add
  a lane or move it behind `PlatformAdapter`.

**Dispatch.** `dispatch()` in `src/dispatch/mod.rs` is a direct `match` that calls each command's `execute()` in
`crates/core/src/commands/`. There is no command trait or registry. Batch is not a second dispatcher: it deserializes
JSON entries into the same `Commands` enum, runs the same `CommandPolicy` preflight and calls the same `dispatch()`.

**Adding a command.**
1. Create `crates/core/src/commands/<name>.rs` with an `execute()` function, its tests in `<name>_tests.rs`, and
   register it in `commands/mod.rs`.
2. Add the CLI variant in `src/cli/mod.rs` and its arguments under `src/cli_args/`.
3. Add its arm to `dispatch()` and to `policy_for()` in `src/command_policy/mod.rs`. Both matches are exhaustive.
4. Add its name to `parse_command()` in `src/batch/mod.rs`; `every_cli_subcommand_is_known_to_batch_parser` fails
   otherwise. Add it to the surface lists in `src/cli/contract_command_surface_tests.rs`.
5. Update the command counts in `README.md` and in this file; `src/cli/doc_literal_drift_tests.rs` checks them.
6. A new `Action` variant goes in `crates/core/src/actions/action.rs`. A new adapter method goes in the matching
   `PlatformAdapter` fragment with a `not_supported` default.
7. Update the matching skill in the same change: `skills/agent-desktop/` for cross-platform behavior, the platform
   skill for what differs, `skills/agent-desktop-ffi/` for the C ABI. The skills compile into the binary and are what
   agents read.

**Crate layout.** Core's root holds only `lib.rs` and domain folders named after `CONCEPTS.md` words: `actionability`,
`actions`, `adapter`, `commands`, `context`, `cursor_overlay`, `input`, `locator`, `notifications`, `ref_action`,
`refs`, `response`, `session`, `snapshot`, `storage`, `system`, `trace`, `tree` and `wait`.
- A platform crate's root holds `lib.rs`, `adapter.rs` (the trait impl) and five layer folders, plus `bin/` where a
  helper binary exists. `tree/` reads, traverses and resolves the UI; `actions/` acts on elements; `input/`
  synthesizes raw keyboard, mouse and clipboard input; `system/` handles app lifecycle, windows, permissions and
  screenshots; `notifications/` handles the OS notification surface.
- Inside a layer, a concept with four or more source files gets a subfolder named from the shared vocabulary
  (`resolve`, `walk`, `properties`, `select`, `scroll`, `clipboard`, `keyboard`, `mouse`, `window`, `capture`, ...).
  File names keep their prefix (`system/window/window_ops.rs`). A file named like its folder becomes its `mod.rs`.
- Tests sit beside their code as `foo_tests.rs`, declared from `foo.rs` with
  `#[cfg(test)] #[path = "foo_tests.rs"] mod tests;`.
- Capability impls live in `adapter.rs` or in the matching layer's `adapter.rs`.

**Grounding rule.** `scripts/check-architecture.sh` (rules in `scripts/check_architecture.py`) runs in the pre-commit
hook and in CI next to the source rules. Before it scans, it plants a violation of every rule, so a rule that stops
detecting fails the gate. It fails when core depends on a platform or OS crate, a platform crate reaches another,
core gains OS-conditional code outside its allow-list, a crate's top-level layout drifts, a capability is implemented
in the wrong layer, core domains reach `commands/`, or a test file is not declared beside its code. Its lists (core
dependencies, core domains, binary folders, OS allow-list) change only in review. The CI `cargo tree` isolation steps
remain the transitive check.

## Coding standards

- **400 lines at most per hand-written `.rs` file** (`scripts/check-rust-file-size.sh`). Split by responsibility.
  A generated `.rs` file with an `@generated` marker in its first five lines is exempt, and the fix goes in the
  generator, not the output. Probe `.ps1` scripts are exempt. The C header is generated by cbindgen and checked by CI
  for drift: change the Rust ABI or `crates/ffi/cbindgen.toml` and regenerate it with `scripts/update-ffi-header.sh`,
  never edit it by hand.
- **No inline comments.** Names carry the meaning. Standalone `//` lines, end-of-line `//` comments and non-doc
  `/* */` blocks are all rejected. The allowed forms are `///` on public items, only when the name is not enough, and
  `//!` module docs. `scripts/check-rust-file-size.sh` enforces this together with the size cap, through
  `scripts/check_rust_comments.py`.
- **No delivery-plan references in `crates/**` or `src/**`**: no phase, sub-phase, plan decision id (`KTD<n>`) or plan
  unit id (`U<n>`). Write what is true about the code and why. Probe ledger row ids such as `A15-7` are allowed and
  encouraged. `scripts/check-no-phase-references.sh` enforces this.
- **One domain struct or enum per file** (`node.rs` holds `AccessibilityNode`). **One command per file**, named after
  the command.
- **At most 7 fields per struct and 5 parameters per function.** Use a config struct or a builder.
- **Explicit `pub` boundaries.** Only `lib.rs` re-exports. Internal modules are `pub(crate)`. No wildcard re-exports.
- **Naming.** Crates are `agent-desktop-<name>`; module files are singular `snake_case`; types are `PascalCase`;
  functions are verb-first `snake_case`; constants are `SCREAMING_SNAKE_CASE`; CLI flags are kebab-case.

**Errors.**
- No `unwrap()`, `expect()` or `panic!` outside tests; panics are test-only. Propagate with `?` or match.
- Adapter functions return `Result<T, AdapterError>`. Command handlers return `Result<serde_json::Value, AppError>`.
  `main()` turns an `AppError` into the JSON envelope and the exit code.
- An error carries `code` (`ErrorCode`), `message`, and optional `suggestion`, `platform_detail` and `details`, plus
  its delivery disposition.
- Codes: `PERM_DENIED`, `ELEMENT_NOT_FOUND`, `APP_NOT_FOUND`, `ACTION_FAILED`, `ACTION_NOT_SUPPORTED`, `STALE_REF`,
  `AMBIGUOUS_TARGET`, `WINDOW_NOT_FOUND`, `PLATFORM_NOT_SUPPORTED`, `TIMEOUT`, `INVALID_ARGS`,
  `NOTIFICATION_NOT_FOUND`, `SNAPSHOT_NOT_FOUND`, `POLICY_DENIED`, `APP_UNRESPONSIVE`, `INTERNAL`.
- Exit codes: `0` success, `1` structured error, `2` argument or parse error.

## Output contract

Every command prints one envelope. `docs/json-output.md` holds the full contract.

```json
{ "version": "2.5", "ok": true, "command": "snapshot",
  "data": { "app": "Finder", "snapshot_id": "s8f3k2p9", "ref_count": 14, "complete": true, "tree": { } } }
```

```json
{ "version": "2.5", "ok": false, "command": "click",
  "error": { "code": "STALE_REF", "message": "...", "suggestion": "...",
             "recovery": { "strategy": "refresh_snapshot_then_retry_original", "retryable": true,
                           "requires_fresh_snapshot": true },
             "disposition": { "delivery": "not_delivered", "retry": "safe" } } }
```

- Omit `None` fields and empty arrays. Compact mode omits bounds. `ref_count` and `tree` live inside `data`.
- Every snapshot carries `data.complete`. A snapshot that runs out of observation budget succeeds with
  `"complete": false`, `"truncated": true`, `"nodes_observed"` and the tree it saw; each cut node carries
  `"subtree_truncated": true`. A `--root` drill-down returns `TIMEOUT` instead of a partial tree.
- Pointer, drag, clipboard, close-app and window commands return the adapter's `OperationReport` as `data`.
  `delivered_verified` needs a postcondition read, `delivered_unverified` means a completed dispatch without one, and
  `not_delivered` is only for an operation already observed as satisfied. Core never adds an unconditional success
  flag such as `clicked`.
- Use `recovery.strategy` only when `disposition.retry` is `safe`.

## Refs and state

`CONCEPTS.md` defines refs, snapshots, sessions, cursors and traces. These rules are the ones code most often breaks:

- Refs are snapshot-qualified (`@s8f3k2p9:e1`) and allocated depth-first. Only the qualified form is accepted as
  input; a bare `@e1` fails with `INVALID_ARGS`. `@eN` is the internal RefMap key only.
- An element gets a ref when its role is interactive (`INTERACTIVE_ROLES` in `crates/core/src/tree/roles.rs`) or it
  advertises a primary action. `SetFocus`, `RightClick` and `ScrollTo` alone do not qualify, because web runtimes
  advertise them on nearly every node.
- Actions re-identify the element strictly from `RefEntry` evidence: pid, role, path and source surface, stable text
  identity and a bounds hash. Control values are volatile and never identity. A mismatch returns `STALE_REF`; several
  live candidates return `AMBIGUOUS_TARGET`.
- All state lives under one root, `~/.agent-desktop` by default. `AGENT_DESKTOP_HOME` relocates it
  (`crates/core/src/storage/state_root.rs`). Refmaps live at `snapshots/<snapshot_id>/refmap.json`, capped at 1 MB each; the
  store keeps the newest 128 snapshots per namespace and prunes to 96. Command code goes through `RefStore`, which
  only reads the legacy `last_refmap.json` to migrate it.
- A session is selected by `--session`, then `AGENT_DESKTOP_SESSION`, then none. `session start` does not activate a
  session for later processes; pass its id. Snapshot lookup never searches another session's namespace.

## macOS adapter gotchas

- macOS reuses `AXUIElementRef` pointers across sibling branches. Guard traversal with an ancestor-path set, never a
  global visited set, or real subtrees disappear.
- `AXElement` keeps its pointer `pub(crate)` to prevent a double free. `Clone` must `CFRetain` and `Drop` must
  `CFRelease`.
- Read attributes in batches with `AXUIElementCopyMultipleAttributeValues`, not one call per attribute.

## Testing and CI

- Unit tests use small purpose-built adapter stubs (see `crates/core/src/adapter/test_support.rs`). Golden JSON in
  `tests/fixtures/` guards serialization.
- The E2E harnesses (`tests/e2e/`, `tests/e2e-windows/`, `tests/e2e-linux/`) drive the built binary against real
  apps. They check every effect by independent observation, never by the command's own `ok: true`. The macOS harness
  covers every ref action in headless and `--headed` mode.
- CI runs fmt, the MSRV build, the core cross-compile checks, clippy and tests per OS, the core isolation check, a
  15 MB binary size check and the FFI header and panic guards.

## Command surface

60 commands spanning App/Window, Observation, Interaction, Scroll, Keyboard, Mouse, Notifications, Clipboard, Wait,
System (including `session`, `trace`, `skills`) and Batch. 56 of the 60 command names are operational on macOS; the
four held-input names (`key-down`, `key-up`, `mouse-down`, `mouse-up`) fail closed. Windows and Linux expose the same
command names. Each platform's limits are in its skill (`skills/agent-desktop-macos/`, `skills/agent-desktop-windows/`,
`skills/agent-desktop-linux/`).

## Definition of done

**Performance.** Check every substantive change for latency against the merge-base before merge. A latency change
must be intended and explained, never found by users.
- macOS: `bash scripts/perf-baseline-compare.sh` writes `report.html`. Add `--apps "Slack,Google Chrome"` for dense
  Electron and Chromium coverage.
- Windows: that script cannot run there. Use the probe cost method instead: min of seven runs with the warm-up
  discarded, reported as the min with the median and max beside it (`probes/windows/FINDINGS.md` A15-13, A18-7).
- Linux: there is no baseline comparison. Hold these budgets: release CLI at most 15 MiB; every command under a silent
  display, a silent bus or a stopped app returns its documented code within its timeout plus 1 s; a snapshot of a
  real app is `complete: true` or cleanly truncated; FFI threads, descriptors and memory stay flat across repeated
  calls; the glibc floor stays at 2.35 or lower (`scripts/check-elf-glibc-floor.sh`).

**Dogfood.** Every platform sub-phase drives its own surface against real software and keeps a judged report.
- Run it as a stranger. The operator gets the shipped skill and the built binary, and nothing else: no source, no plan.
  A subagent that does it is told so and denied the repo.
- Run every example in the shipped docs verbatim in the platform's default shell. An example that cannot run as
  written is a defect of the same weight as a broken command.
- Reaching for a flag, variable or ordering the skill does not document ends the run as a finding.
- A report with no findings is a failed dogfood, not a passed one.
- Read every step's `ok`. Wait with the tool's own wait primitives; a fixed sleep and then a check is a race.
  Confirm a failure twice before you report it. Measure a behavioral claim in both directions before you write it down.
- Give every finding exactly one disposition: fixed here, with a named test that you invert-verify (break the fix,
  watch the test fail, restore); owned elsewhere, written into the receiving phase of the local roadmap; or accepted,
  with a reason. "Recorded" is not a disposition.
- Reports and their evidence stay out of version control.
- Every requirement in a plan maps to at least one test that fails when the requirement is violated.
