# Linux distribution checks

The supported live-desktop floor is Ubuntu 24.04. CLI and FFI artifacts still
build in pinned Ubuntu 22.04 containers and must pass the glibc 2.35 floor
check. The `linux-consumer` jobs run those extracted artifacts directly on
the hosted Ubuntu 24.04 x64 and ARM64 runners, in private Openbox sessions.
The binary loader floor does not certify an older desktop stack.

Ubuntu 22.04's ATK bridge 2.38.0 aborts inside the application's
`Action.GetActions`: it declares `(sss)` entries but appends four strings.
The library's tree traversal calls that method; the app abort leaves it with
`TIMEOUT` and zero nodes. The fault is in the application's in-process bridge,
rather than in `at-spi2-registryd` or the Rust `zbus` library.
Ubuntu 24.04's 2.52.0 bridge contains the [upstream fix](https://github.com/GNOME/at-spi2-core/commit/dc0dc33).

On 22.04 the consumer fails at `windows-exact: FAIL code=TIMEOUT rc=-9 nodes=0`
after dbus logs a signature error for `a(sss)`. An isolated probe compiled the
unmodified `impl_GetActions` handlers from the official Ubuntu
[2.38.0](https://archive.ubuntu.com/ubuntu/pool/main/a/at-spi2-atk/at-spi2-atk_2.38.0.orig.tar.xz)
and [2.52.0](https://archive.ubuntu.com/ubuntu/pool/main/a/at-spi2-core/at-spi2-core_2.52.0.orig.tar.xz) source tarballs against libdbus
1.12.20, supplying one fake ATK action. The Jammy (22.04) handler exited by SIGABRT
with that exact signature error; the Noble (24.04) handler exited 0 with reply
signature `a(sss)`. The probe measures the faulty serializer, not a full 22.04
desktop reproduction.

## Running the checks

Build the CLI, FFI library and clipboard owner from the same checkout. Create
the CLI and FFI archives using the release workflow layout. Run each of the
first three commands inside its own private session. `scripts/private-session.sh --wm` starts a
private session bus, Xvfb display and Openbox; it looks for Openbox at
`$AGENT_DESKTOP_WM_ROOT/usr/bin/openbox` (`AGENT_DESKTOP_WM_ROOT` defaults to `/`).
Set it to an alternate installation root when needed. The apt
packages the checks need are listed in the `linux-consumer` job of
`.github/workflows/release-dry-run.yml`; the npm check also needs Node and npm.

```sh
export AGENT_DESKTOP_WM_ROOT=/
scripts/private-session.sh --wm -- tests/linux-dist/run-consumer.sh <extracted-ffi-directory>
scripts/private-session.sh --wm -- scripts/ci-ffi-helper-discovery-smoke.sh
scripts/private-session.sh --wm -- tests/linux-dist/run-npm-install.sh <archives-directory>
python3 -I -m unittest discover -s tests/ffi-python -p 'test_linux_helper.py'
python3 -I -m unittest discover -s tests/linux-dist -p 'test_*.py'
```

`<extracted-ffi-directory>` is the extracted FFI archive, holding
`lib/libagent_desktop_ffi.so` and `include/agent_desktop.h`.
`<archives-directory>` holds the CLI archive for this architecture
(`agent-desktop-v*-<target>.tar.gz`); `run-npm-install.sh` serves it through a
PATH-first `curl` double so the postinstall download and checksum path runs.

The FFI discovery script expects the library in `target/release-ffi` (or
`target/release`) and the owner in `target/release`; the consumer job copies
both there from the extracted FFI archive. The script copies both into a fresh
directory and empties PATH during clipboard calls. A foreign GTK reader must
receive the payload after adapter destruction, then observe an empty selection
after clear. The npm check applies the same contract after the installed CLI
process exits. The release dry-run installs the GTK 3 typelib, runs the fake
contracts, and stages the discovery check from that job's extracted archive.

The consumer also runs the real ctypes smoke against the extracted library
and header while Calculator is registered, requiring complete main-thread
and worker-thread snapshots with refs. A smoke failure fails the consumer.
Both C and npm click checks require a readable baseline different from `7`
before dispatch, a unique button ref, and an independent readback of `7`.
Clipboard clear accepts only the reader's no-text status; observer errors
fail the check. The deterministic tests listed above cover these contracts
with fakes.

To confirm that discovery fails without a helper, stage only the library,
point `AD_DYLIB_PATH` at it, set
`AD_HEADER_PATH=crates/ffi/include/agent_desktop.h`, `AD_EXPECT_LINUX_HELPER=1`
and `AD_HELPER_EMPTY_PATH` to an empty directory, and run
`python3 tests/ffi-python/smoke.py` in a private session. It must fail with
the missing clipboard owner error. Borrowing another checkout's helper would
invalidate this check.

## Test design rules

- The C lifetime leg runs twenty create/snapshot/destroy cycles and checks that
  a destroyed handle returns `INVALID_ARGS`. It does not start a snapshot
  thread and race it against destroy, because scheduling does not establish
  which operation acquired the handle first. The Rust test
  `destroy_revokes_new_calls_without_invalidating_in_flight_owners`
  (`crates/ffi/src/adapter_tests.rs`) holds an owner explicitly and tests
  in-flight retention without a scheduling race.
- The foreign clipboard reader explicitly selects both GTK 3 and GDK 3. Leaving
  GDK unversioned selects GDK 4 on a host with both toolkits and prevents any
  clipboard observation; a fake GI test rejects that mismatch.
- Private bus cleanup (`private_bus.py`) signals through PID handles and checks
  process generation and exact runtime membership before and after opening the
  handle, then waits for an observed exit. It does not use a PID list with a
  fixed delay. Fake process tests reject PID reuse and foreign runtime membership.

## Evidence

Measured results for this tooling are recorded in `probes/linux/FINDINGS.md`:
`L22-16` (glibc 2.35 floor), `L22-18` (apt package set), `L22-19` (hosted-runner
capability) and `L22-20` (npm install and detached clipboard ownership).
