# Build and link

## Building the cdylib

```sh
cargo build --profile release-ffi -p agent-desktop-ffi
```

Output:

- macOS: `target/release-ffi/libagent_desktop_ffi.dylib`
- Linux: `target/release-ffi/libagent_desktop_ffi.so`
- Windows: `target/release-ffi/agent_desktop_ffi.dll`

The generated header is `crates/ffi/include/agent_desktop.h`.

`--profile release-ffi` keeps `panic = "unwind"`, which the `catch_unwind` traps
inside every `extern "C"` entrypoint need. The default `release` profile uses
`panic = "abort"` and silently defeats those traps.

## Prebuilt archives

Every GitHub release ships prebuilt archives for:

- macOS arm64 and x86_64
- Linux x64 and arm64 (glibc)
- Windows x64 and ARM64 MSVC

The archives are named `agent-desktop-ffi-v<version>-<target>.tar.gz` (`.zip` on
Windows), with `<target>` the Rust target triple. Each archive unpacks to a directory of
the same name holding `lib/` (the dylib, so, or dll), `include/agent_desktop.h`,
`LICENSE`, and a `README.md`. `lib/` also holds a helper that must stay beside the library:
`agent-desktop-macos-helper` on macOS, `agent-desktop-linux-clipboard-owner` on
Linux. On Windows it holds the `agent_desktop_ffi.dll.lib` import library, which an
MSVC linking consumer links against. Integrity: compare against `checksums.txt` in
the release assets. Supply-chain verification: each release carries a Sigstore
attestation; verify with `gh attestation verify <file> --repo vercel-labs/agent-desktop`
before deploying.

## ABI handshake (do this first)

After `dlopen` / `LoadLibrary`, compare the dylib major to the header you
compiled against before calling anything else:

```c
AdResult rc = ad_init(AD_ABI_VERSION_MAJOR);
if (rc != AD_RESULT_OK) {
    // header and dylib have incompatible major versions
    fprintf(stderr, "ABI mismatch: %s\n", ad_last_error_message());
    return -1;
}
```

Alternatively, read the raw dylib major and compare yourself:

```c
uint32_t dylib_major = ad_abi_version();
if (dylib_major != AD_ABI_VERSION_MAJOR) {
    fprintf(stderr, "ABI major: header=%u dylib=%u\n",
            AD_ABI_VERSION_MAJOR, dylib_major);
    abort();
}
```

`ad_init` returns `AD_RESULT_ERR_INVALID_ARGS` on mismatch, with a diagnostic in
`ad_last_error_message`. Call nothing further.

## Struct size validation

Languages whose struct layout may diverge from C (Python ctypes, Go cgo, JNI,
etc.) must validate every size-pinned struct before passing it to the library.
The FFI exposes three validation layers:

1. **Header macros** (`AD_*_SIZE`) and
2. **Runtime getters** (`ad_*_size()`, returning `size_t` compiled from the Rust
   side, equal to the macro):

   | Struct | Macro | Getter |
   |--------|-------|--------|
   | `AdAction` | `AD_ACTION_SIZE` | `ad_action_size()` |
   | `AdActionResult` | `AD_ACTION_RESULT_SIZE` | `ad_action_result_size()` |
   | `AdActionStep` | `AD_ACTION_STEP_SIZE` | `ad_action_step_size()` |
   | `AdDisplayInfo` | `AD_DISPLAY_INFO_SIZE` | `ad_display_info_size()` |
   | `AdDragParams` | `AD_DRAG_PARAMS_SIZE` | `ad_drag_params_size()` |
   | `AdElementState` | `AD_ELEMENT_STATE_SIZE` | `ad_element_state_size()` |
   | `AdExactRefEntry` | `AD_EXACT_REF_ENTRY_SIZE` | `ad_exact_ref_entry_size()` |
   | `AdExactSurfaceInfo` | `AD_EXACT_SURFACE_INFO_SIZE` | `ad_exact_surface_info_size()` |
   | `AdExactWindowInfo` | `AD_EXACT_WINDOW_INFO_SIZE` | `ad_exact_window_info_size()` |
   | `AdRefEntry` | `AD_REF_ENTRY_SIZE` | `ad_ref_entry_size()` |
   | `AdWaitArgs` | `AD_WAIT_ARGS_SIZE` | `ad_wait_args_size()` |

3. **C11 static asserts** in the header (`#ifndef AGENT_DESKTOP_ABI_ASSERTS`)
   catch mismatches at C compile time.

Compare your binding's `sizeof` equivalent against the getter at load time, before
building or passing any of these structs. Set `AdExactRefEntry.version` to
`AD_EXACT_REF_ENTRY_VERSION`, `.size` to `AD_EXACT_REF_ENTRY_SIZE`, and
`.process_instance` to the generation token the snapshot emitted.

## Worked example: Python ctypes smoke harness

`tests/ffi-python/smoke.py` is the reference for Python consumers. It uses only the
Python standard library. Legs:

- Leg 1: `ad_abi_version()` vs `AD_ABI_VERSION_MAJOR`.
- Leg 2: the size getters for `AdAction`, `AdActionResult`, `AdActionStep`,
  `AdDragParams`, `AdElementState`, `AdRefEntry`, and `AdWaitArgs` vs their macros.
- Leg 3: `ad_version()`, parse the JSON, `ad_free_string`.
- Leg 4: `ad_adapter_create`, `ad_snapshot`, `ad_free_string`, `ad_adapter_destroy`.
  A stub-adapter build yields a `PLATFORM_NOT_SUPPORTED` envelope.

Run it:

```bash
python3 tests/ffi-python/smoke.py \
  target/release-ffi/libagent_desktop_ffi.dylib \
  crates/ffi/include/agent_desktop.h
```

Or with environment variables:

```bash
AD_DYLIB_PATH=target/release-ffi/libagent_desktop_ffi.dylib \
AD_HEADER_PATH=crates/ffi/include/agent_desktop.h \
python3 tests/ffi-python/smoke.py
```

`tests/ffi-python/README.md` covers the stub-adapter build and the `AD_EXPECT_*`
switches.

## Minimal C example

```c
#include <stdio.h>
#include "agent_desktop.h"

int main(void) {
    // 1. ABI handshake
    if (ad_init(AD_ABI_VERSION_MAJOR) != AD_RESULT_OK) {
        fprintf(stderr, "ABI mismatch: %s\n", ad_last_error_message());
        return 1;
    }

    // 2. Create adapter
    AdAdapter *adapter = ad_adapter_create();
    if (!adapter) {
        fprintf(stderr, "adapter_create failed: %s\n", ad_last_error_message());
        return 1;
    }

    // 3. Check permissions
    AdResult rc = ad_check_permissions(adapter);
    if (rc != AD_RESULT_OK) {
        fprintf(stderr, "permission denied: %s\n", ad_last_error_message());
        ad_adapter_destroy(adapter);
        return 1;
    }

    // 4. Snapshot the focused window
    char *json_out = NULL;
    rc = ad_snapshot(adapter,
                     NULL,                       // app (null = focused window)
                     AD_SNAPSHOT_SURFACE_WINDOW, // surface
                     10,                         // max_depth
                     false,                      // interactive_only
                     false,                      // compact
                     &json_out);
    if (rc == AD_RESULT_OK && json_out) {
        printf("%s\n", json_out);
        // parse the JSON to find qualified refs in data.tree
        ad_free_string(json_out);
    } else if (json_out) {
        // command-level error: ok:false envelope, still must free
        fprintf(stderr, "snapshot error: %s\n", json_out);
        ad_free_string(json_out);
    } else {
        // infrastructure error: *out is null
        fprintf(stderr, "snapshot failed: %s\n", ad_last_error_message());
    }

    ad_adapter_destroy(adapter);
    return 0;
}
```

Compile (macOS and Linux):

```sh
clang -I./crates/ffi/include main.c \
      -L./target/release-ffi -lagent_desktop_ffi \
      -Wl,-rpath,"$PWD/target/release-ffi" \
      -o snapshot_demo
```

The macOS install name is `@rpath/libagent_desktop_ffi.dylib`, so a linking consumer
needs an rpath to the library's directory or dyld aborts at launch. `dlopen` and
ctypes callers resolve by path and need nothing.

## Observe-act workflow in C

After parsing the snapshot JSON and extracting a qualified ref ID:

```c
AdAction act = {0};              // zero-init before setting any field
act.kind = AD_ACTION_KIND_CLICK;

char *result = NULL;
AdResult rc = ad_execute_by_ref(
    adapter,
    "@s8f3k2p9:e5", // qualified ref from snapshot data.tree
    &act,
    AD_POLICY_KIND_HEADLESS,
    &result
);
if (result) {
    // parse JSON: ok:true on success, ok:false on STALE_REF etc.
    printf("%s\n", result);
    ad_free_string(result);
}
if (rc != AD_RESULT_OK) {
    fprintf(stderr, "execute_by_ref failed (%d): %s\n",
            (int)rc, ad_last_error_message());
}
```

To type text, set the action kind and text field:

```c
AdAction type_act = {0};
type_act.kind = AD_ACTION_KIND_TYPE_TEXT;
type_act.text = "hello";
// TypeText runs headless by default; opt in to focus fallback explicitly:
rc = ad_execute_by_ref(adapter, "@s8f3k2p9:e3", &type_act,
                       AD_POLICY_KIND_FOCUS_FALLBACK, &result);
```

## Minimal Python ctypes example

```python
import ctypes, json
from ctypes import c_int32, c_uint8, c_bool, c_char_p, POINTER, c_void_p

lib = ctypes.CDLL("./target/release-ffi/libagent_desktop_ffi.dylib")

# ABI handshake
lib.ad_init.restype = c_int32
lib.ad_init.argtypes = [ctypes.c_uint32]
AD_ABI_VERSION_MAJOR = 6  # sync with header macro
rc = lib.ad_init(AD_ABI_VERSION_MAJOR)
assert rc == 0, f"ABI mismatch: rc={rc}"

# Adapter lifecycle
lib.ad_adapter_create.restype = c_void_p
lib.ad_adapter_create.argtypes = []
lib.ad_adapter_destroy.restype = None
lib.ad_adapter_destroy.argtypes = [c_void_p]

# Snapshot
lib.ad_snapshot.restype = c_int32
lib.ad_snapshot.argtypes = [c_void_p, c_char_p, c_int32, c_uint8, c_bool, c_bool,
                             POINTER(c_char_p)]
lib.ad_free_string.restype = None
lib.ad_free_string.argtypes = [c_char_p]

lib.ad_last_error_message.restype = c_char_p
lib.ad_last_error_message.argtypes = []

adapter = lib.ad_adapter_create()
assert adapter, "ad_adapter_create() returned null"

out = c_char_p()
rc = lib.ad_snapshot(adapter, None, 0, 10, False, False, ctypes.byref(out))
if out.value:
    envelope = json.loads(out.value)
    lib.ad_free_string(out)
    print("ok:", envelope.get("ok"))
else:
    msg = lib.ad_last_error_message()
    print("error:", msg.decode() if msg else "(no message)")

lib.ad_adapter_destroy(adapter)
```
