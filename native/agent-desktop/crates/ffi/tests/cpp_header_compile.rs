//! Verifies the committed C header is also a valid C++17 interface.

#[path = "common/header_temp.rs"]
mod header_temp;

use std::path::PathBuf;
use std::process::Command;

fn system_cxx() -> Option<&'static str> {
    ["c++", "clang++", "g++"].into_iter().find(|compiler| {
        Command::new(compiler)
            .arg("--version")
            .output()
            .is_ok_and(|output| output.status.success())
    })
}

fn header_include_dir() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("include")
}

#[test]
fn committed_header_compiles_as_cpp17_with_portable_abi_types() {
    let Some(cxx) = system_cxx() else {
        eprintln!("skipping: system C++ compiler not found");
        return;
    };

    let directory = header_temp::HeaderTemp::new();
    let tmp = directory.0.join("header.cpp");
    let obj = directory.0.join("header.o");
    let src = r#"
#include <cstdint>
#include <limits>
#include <type_traits>
#include "agent_desktop.h"

static void log_callback(std::int32_t level, const char *message) {
    (void)level;
    (void)message;
}

static_assert(std::is_enum_v<AdModifier>);
static_assert(std::is_same_v<std::underlying_type_t<AdModifier>, std::int32_t>);
static_assert(AD_MODIFIER_META == 0);
static_assert(AD_MODIFIER_CTRL == 1);
static_assert(AD_MODIFIER_ALT == 2);
static_assert(AD_MODIFIER_SHIFT == 3);
static_assert(AD_MODIFIER_CMD == AD_MODIFIER_META);

static_assert(std::is_enum_v<AdSnapshotSurface>);
static_assert(std::is_same_v<std::underlying_type_t<AdSnapshotSurface>, std::int32_t>);
static_assert(AD_SNAPSHOT_SURFACE_WINDOW == 0);
static_assert(AD_SNAPSHOT_SURFACE_FOCUSED == 1);
static_assert(AD_SNAPSHOT_SURFACE_MENU == 2);
static_assert(AD_SNAPSHOT_SURFACE_MENUBAR == 3);
static_assert(AD_SNAPSHOT_SURFACE_SHEET == 4);
static_assert(AD_SNAPSHOT_SURFACE_POPOVER == 5);
static_assert(AD_SNAPSHOT_SURFACE_ALERT == 6);
static_assert(AD_SNAPSHOT_SURFACE_DESKTOP == 7);
static_assert(AD_SNAPSHOT_SURFACE_TASKBAR == 8);
static_assert(AD_SNAPSHOT_SURFACE_SYSTEM_TRAY == 9);
static_assert(AD_SNAPSHOT_SURFACE_QUICK_SETTINGS == 10);
static_assert(AD_SNAPSHOT_SURFACE_NOTIFICATION_CENTER == 11);
static_assert(AD_SNAPSHOT_SURFACE_TOOLBAR == 12);
static_assert(AD_SNAPSHOT_SURFACE_DOCK == 13);
static_assert(AD_SNAPSHOT_SURFACE_SPOTLIGHT == 14);
static_assert(AD_SNAPSHOT_SURFACE_MENU_BAR_EXTRAS == 15);
static_assert(AD_SNAPSHOT_SURFACE_SYSTEM_TRAY_OVERFLOW == 16);
static_assert(AD_SNAPSHOT_SURFACE_START_MENU == 17);
static_assert(AD_SNAPSHOT_SURFACE_ACTION_CENTER == 18);

static_assert(AD_DELIVERY_DISPOSITION_UNKNOWN == 0);
static_assert(AD_DELIVERY_DISPOSITION_NOT_DELIVERED == 1);
static_assert(AD_DELIVERY_DISPOSITION_DELIVERY_UNCERTAIN == 2);
static_assert(AD_DELIVERY_DISPOSITION_DELIVERED_UNVERIFIED == 3);
static_assert(AD_DELIVERY_DISPOSITION_DELIVERED_VERIFIED == 4);
static_assert(AD_FIND_SELECTION_KIND_STRICT == 0);
static_assert(AD_FIND_SELECTION_KIND_FIRST == 1);
static_assert(AD_FIND_SELECTION_KIND_LAST == 2);
static_assert(AD_FIND_SELECTION_KIND_NTH == 3);
static_assert(AD_IDENTIFIER_KIND_AX_IDENTIFIER == 0);
static_assert(AD_IDENTIFIER_KIND_AX_DOM_IDENTIFIER == 1);
static_assert(AD_IDENTIFIER_KIND_AUTOMATION_ID == 2);
static_assert(AD_IDENTIFIER_KIND_RUNTIME_ID == 3);
static_assert(AD_IDENTIFIER_KIND_ATSPI_OBJECT_PATH == 4);
static_assert(AD_POLICY_KIND_HEADLESS == 0);
static_assert(AD_POLICY_KIND_FOCUS_FALLBACK == 1);
static_assert(AD_POLICY_KIND_HEADED == 2);
static_assert(AD_RETRY_DISPOSITION_UNKNOWN == 0);
static_assert(AD_RETRY_DISPOSITION_SAFE == 1);
static_assert(AD_RETRY_DISPOSITION_UNSAFE == 2);
static_assert(AD_STEP_MECHANISM_SEMANTIC_API == 1);
static_assert(AD_STEP_MECHANISM_PHYSICAL_SYNTHETIC == 2);

using AppPid = decltype(AdAppInfo{}.pid);
using WindowPid = decltype(AdWindowInfo{}.pid);
using RefPid = decltype(AdRefProcess{}.pid);
static_assert(std::is_same_v<AppPid, std::uint32_t>);
static_assert(std::is_same_v<WindowPid, std::uint32_t>);
static_assert(std::is_same_v<RefPid, std::uint32_t>);
static_assert(std::numeric_limits<AppPid>::max() == UINT32_MAX);

using ListExactSurfacesFn = AdResult (*)(const AdAdapter *, std::uint32_t, AdExactSurfaceList **);
using ListDisplaysFn = AdResult (*)(const AdAdapter *, AdDisplayList **);
static_assert(std::is_same_v<decltype(&ad_list_surfaces_exact), ListExactSurfacesFn>);
static_assert(std::is_same_v<decltype(&ad_list_displays), ListDisplaysFn>);
static_assert(sizeof(AdDisplayInfo) == AD_DISPLAY_INFO_SIZE);
static_assert(offsetof(AdDisplayInfo, id) == 8);
static_assert(offsetof(AdDisplayInfo, scale) == 56);

int main() {
    const auto callback_result = ad_set_log_callback(log_callback);
    const auto clear_callback_result = ad_set_log_callback(nullptr);
    (void)callback_result;
    (void)clear_callback_result;
    return 0;
}
"#;
    std::fs::write(&tmp, src).expect("write C++17 test translation unit");

    let output = Command::new(cxx)
        .arg("-std=c++17")
        .arg("-pedantic-errors")
        .arg("-Wall")
        .arg("-Wextra")
        .arg("-Werror")
        .arg("-I")
        .arg(header_include_dir())
        .arg("-c")
        .arg(&tmp)
        .arg("-o")
        .arg(&obj)
        .output()
        .expect("C++ compiler invocation failed");

    let _ = std::fs::remove_file(&tmp);
    let _ = std::fs::remove_file(&obj);

    assert!(
        output.status.success(),
        "C++17 compile of agent_desktop.h failed:\n{}",
        String::from_utf8_lossy(&output.stderr)
    );
}
