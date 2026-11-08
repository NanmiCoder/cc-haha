# FFI Python Smoke Harness

Proves the C ABI works from a non-Rust host (Python ctypes) and gates it in CI.

## What it tests

| Leg | Check |
|-----|-------|
| 1 | `ad_abi_version()` equals `AD_ABI_VERSION_MAJOR` from the header (catches header/dylib mismatch at import) |
| 2 | Every `ad_*_size()` getter equals the corresponding `AD_*_SIZE` macro (catches struct layout drift) |
| 3 | `ad_version()` returns `ok:true` JSON with `data.version` (basic command pipeline) |
| 4 | `ad_adapter_create` → `ad_snapshot` → `ad_free_string` → `ad_adapter_destroy` without crash or leak; stub adapter yields a clean `PLATFORM_NOT_SUPPORTED` envelope |
| 5 | Opt-in (`AD_EXPECT_REAL=1`, optional `AD_APP`, default `gnome-calculator`): the real adapter returns a complete snapshot with refs for the named app on the main thread and on a worker thread. Run by `tests/linux-dist/run-consumer.sh` |
| Linux helper | Opt-in (`AD_EXPECT_LINUX_HELPER=1` with `AD_HELPER_EMPTY_PATH`, run by `scripts/ci-ffi-helper-discovery-smoke.sh`): with an empty `PATH`, the library finds the clipboard owner beside it, a foreign GTK reader sees the text it sets, and clear empties the selection |
| 6 | Opt-in (`AD_EXPECT_MACOS_HELPER=1`, run by `scripts/ci-ffi-helper-discovery-smoke.sh`): macOS helper discovery |

## Building the dylib

```bash
# From the repo root:
cargo build --locked --profile release-ffi -p agent-desktop-ffi --features stub-adapter
```

The dylib lands at `target/release-ffi/libagent_desktop_ffi.dylib` (macOS) or
`target/release-ffi/libagent_desktop_ffi.so` (Linux).

`--profile release-ffi` keeps `panic = "unwind"`, which is required for the
`catch_unwind` traps inside the FFI layer. Using the default `release` profile
(which has `panic = "abort"`) would silently defeat those traps.

`--features stub-adapter` replaces the real platform adapter with a no-op that
returns `PLATFORM_NOT_SUPPORTED` for every adapter call. This lets CI run the
harness without requiring macOS Accessibility permissions.

## Running locally

```bash
# macOS (arm64 or x86_64):
python3 tests/ffi-python/smoke.py \
  target/release-ffi/libagent_desktop_ffi.dylib \
  crates/ffi/include/agent_desktop.h
```

Alternatively, use environment variables:

```bash
export AD_DYLIB_PATH=target/release-ffi/libagent_desktop_ffi.dylib
export AD_HEADER_PATH=crates/ffi/include/agent_desktop.h
python3 tests/ffi-python/smoke.py
```

## Stub enforcement (`AD_EXPECT_STUB=1`)

Set `AD_EXPECT_STUB=1` when running the harness against a stub-adapter build.
With this variable set, the harness fails if `ad_snapshot()` returns `ok:true`,
which would indicate the dylib was **not** built with `--features stub-adapter`.
The stub Python smoke step on the macOS leg of the `ffi-panic-guard` CI job sets this variable so a real-adapter dylib cannot
accidentally pass the stub-only gate.

## Dependencies

`smoke.py` uses only the Python standard library (`ctypes`, `json`, `os`, `re`,
`pathlib`, `sys`, `threading`). No `pip install` is required, except for the
Linux helper leg: `linux_helper.py` reads the clipboard as a foreign GTK client
and needs PyGObject with the GTK 3 typelib (`python3-gi`, `gir1.2-gtk-3.0`).

## Real-adapter happy path

Legs 1 to 4 gate the permission-independent surface (ABI version, struct sizes,
`ad_version`) and the `PLATFORM_NOT_SUPPORTED` passthrough path. A successful
`ad_snapshot` with `ok:true` from the real adapter is covered elsewhere. On
macOS, the native E2E harness covers it (`tests/e2e/run.sh`, whose `ffi_live.py`
drives the release FFI library) and requires AX permission. On Linux, Leg 5
covers it.

## Other files

| File | Purpose |
|------|---------|
| `linux_helper.py` | The Linux helper leg, and `verify_cli` for the installed CLI (used by `tests/linux-dist/run-npm-install.sh`) |
| `test_linux_helper.py` | Unit tests for `linux_helper.py`: `python3 -I -m unittest discover -s tests/ffi-python -p 'test_linux_helper.py'` |
| `leak_probe.py` | Linux only, not run by CI: `python3 tests/ffi-python/leak_probe.py <library.so> [--calls N]` points the library at a silent X11 TCP server and checks that repeated timed-out `ad_list_displays` calls keep the host's thread and descriptor counts flat |
