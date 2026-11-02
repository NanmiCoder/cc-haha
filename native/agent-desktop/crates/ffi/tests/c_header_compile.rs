//! Verifies the committed FFI header compiles as C and that every named
//! enum discriminant documented in the header is usable from C code. This
//! guards against header drift that would silently drop the `AdActionKind` /
//! `AdDirection` / etc. enum blocks, forcing C consumers to hard-code numeric
//! literals instead of AD_* constants.
//!
//! The test shells out to the system `cc`; it skips on platforms where
//! that binary is not on PATH so cargo test still passes on bare CI
//! images.

#[path = "common/header_temp.rs"]
mod header_temp;

use std::path::PathBuf;
use std::process::Command;

fn system_cc() -> Option<&'static str> {
    let cc = if cfg!(target_os = "windows") {
        "cl"
    } else {
        "cc"
    };
    Command::new(cc)
        .arg("--version")
        .output()
        .ok()
        .filter(|o| o.status.success())
        .map(|_| cc)
}

fn header_include_dir() -> PathBuf {
    let mut p = PathBuf::from(env!("CARGO_MANIFEST_DIR"));
    p.push("include");
    p
}

#[test]
fn committed_header_compiles_with_every_public_enum_constant() {
    let cc = match system_cc() {
        Some(cc) => cc,
        None => {
            eprintln!("skipping: system C compiler not found");
            return;
        }
    };

    let directory = header_temp::HeaderTemp::new();
    let tmp = directory.0.join("header.c");
    let obj = directory.0.join("header.o");
    let src = r#"
#include <stdint.h>
#include <stdbool.h>
#include <stddef.h>
#include "agent_desktop.h"

static void log_callback(int32_t level, const char *message) {
    (void)level;
    (void)message;
}

int main(void) {
    (void)AD_ACTION_KIND_CLICK;
    (void)AD_DIRECTION_UP;
    (void)AD_DELIVERY_DISPOSITION_DELIVERED_VERIFIED;
    (void)AD_FIND_SELECTION_KIND_STRICT;
    (void)AD_IDENTIFIER_KIND_AX_IDENTIFIER;
    (void)AD_MODIFIER_META;
    (void)AD_MODIFIER_CMD;
    (void)AD_MOUSE_BUTTON_LEFT;
    (void)AD_MOUSE_EVENT_KIND_MOVE;
    (void)AD_POLICY_KIND_HEADLESS;
    (void)AD_RETRY_DISPOSITION_SAFE;
    (void)AD_SCREENSHOT_KIND_FULL_SCREEN;
    (void)AD_SNAPSHOT_SURFACE_WINDOW;
    (void)AD_STEP_MECHANISM_SEMANTIC_API;
    (void)AD_WINDOW_OP_KIND_RESIZE;
    (void)AD_IMAGE_FORMAT_PNG;
    (void)AD_RESULT_OK;
    _Static_assert(AD_ACTION_SIZE == sizeof(AdAction), "AdAction size macro drifted");
    _Static_assert(AD_DRAG_PARAMS_SIZE == sizeof(AdDragParams), "AdDragParams size macro drifted");
    _Static_assert(AD_ACTION_STEP_SIZE == sizeof(AdActionStep), "AdActionStep size macro drifted");
    _Static_assert(AD_ACTION_RESULT_SIZE == sizeof(AdActionResult), "AdActionResult size macro drifted");
    _Static_assert(offsetof(AdActionResult, steps) == 24, "AdActionResult.steps offset changed");
    _Static_assert(offsetof(AdActionResult, step_count) == 32, "AdActionResult.step_count offset changed");
    _Static_assert(offsetof(AdActionResult, details_json) == 40, "AdActionResult.details_json offset changed");
    _Static_assert(offsetof(AdActionResult, disposition) == 48, "AdActionResult.disposition offset changed");
    _Static_assert(AD_DELIVERY_SEMANTICS_SIZE == sizeof(AdDeliverySemantics), "AdDeliverySemantics size macro drifted");
    _Static_assert(offsetof(AdActionStep, outcome) == 8, "AdActionStep.outcome offset changed");
    _Static_assert(offsetof(AdActionStep, mechanism) == 16, "AdActionStep.mechanism offset changed");
    _Static_assert(offsetof(AdActionStep, has_mechanism) == 20, "AdActionStep.has_mechanism offset changed");
    _Static_assert(offsetof(AdActionStep, verified) == 21, "AdActionStep.verified offset changed");
    _Static_assert(offsetof(AdActionStep, has_verified) == 22, "AdActionStep.has_verified offset changed");
    _Static_assert(AD_ELEMENT_STATE_SIZE == sizeof(AdElementState), "AdElementState size macro drifted");
    _Static_assert(AD_DISPLAY_INFO_SIZE == sizeof(AdDisplayInfo), "AdDisplayInfo size macro drifted");
    _Static_assert(offsetof(AdDisplayInfo, id) == 8, "AdDisplayInfo.id offset changed");
    _Static_assert(offsetof(AdDisplayInfo, scale) == 56, "AdDisplayInfo.scale offset changed");
    _Static_assert(_Generic(((AdAppInfo){0}).pid, uint32_t: 1, default: 0), "AdAppInfo.pid must be uint32_t");
    _Static_assert(_Generic(((AdWindowInfo){0}).pid, uint32_t: 1, default: 0), "AdWindowInfo.pid must be uint32_t");
    _Static_assert(_Generic(((AdRefProcess){0}).pid, uint32_t: 1, default: 0), "AdRefProcess.pid must be uint32_t");
    AdResult (*list_surfaces_exact)(const struct AdAdapter *, uint32_t, struct AdExactSurfaceList **) = ad_list_surfaces_exact;
    AdResult (*list_displays)(const struct AdAdapter *, struct AdDisplayList **) = ad_list_displays;
    AdResult callback_result = ad_set_log_callback(log_callback);
    AdResult clear_callback_result = ad_set_log_callback(NULL);
    (void)list_surfaces_exact;
    (void)list_displays;
    (void)callback_result;
    (void)clear_callback_result;
    (void)ad_action_step_size;
    (void)ad_ref_entry_size;
    (void)ad_exact_ref_entry_size;
    (void)ad_exact_surface_info_size;
    (void)ad_exact_window_info_size;
    (void)ad_display_info_size;
    (void)ad_last_error_details;
    (void)ad_last_error_delivery_semantics;
    _Static_assert(AD_REF_ENTRY_SIZE == sizeof(AdRefEntry), "AdRefEntry size macro drifted");
    _Static_assert(AD_REF_ENTRY_SIZE == 200, "AdRefEntry ABI size changed");
    _Static_assert(AD_EXACT_REF_ENTRY_SIZE == sizeof(AdExactRefEntry), "AdExactRefEntry size macro drifted");
    _Static_assert(AD_EXACT_REF_ENTRY_SIZE == 224, "AdExactRefEntry ABI size changed");
    _Static_assert(AD_EXACT_SURFACE_INFO_SIZE == sizeof(AdExactSurfaceInfo), "AdExactSurfaceInfo size macro drifted");
    _Static_assert(AD_EXACT_WINDOW_INFO_SIZE == sizeof(AdExactWindowInfo), "AdExactWindowInfo size macro drifted");
    return 0;
}
"#;
    std::fs::write(&tmp, src).expect("write test translation unit");

    let include = header_include_dir();
    let status = Command::new(cc)
        .arg("-std=c11")
        .arg("-pedantic-errors")
        .arg("-Wall")
        .arg("-Werror")
        .arg("-I")
        .arg(&include)
        .arg("-c")
        .arg(&tmp)
        .arg("-o")
        .arg(&obj)
        .status()
        .expect("cc invocation failed");

    let _ = std::fs::remove_file(&tmp);
    let _ = std::fs::remove_file(&obj);

    assert!(
        status.success(),
        "C compile of agent_desktop.h failed — a named enum constant is missing. \
         Check crates/ffi/include/agent_desktop.h."
    );
}
