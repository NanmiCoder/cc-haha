//! Kind-table tests: what the table itself decides - a build refusal naming
//! the capability holder, and a class chain that matches nothing timing out
//! as a reach answer - independent of any live desktop state.

use super::*;

use agent_desktop_core::ErrorCode;

use crate::system::shell::shell_surface::build_number;
use crate::system::shell::shell_surface_open::{open_row, open_surface};

use crate::system::fixture::test_time::{deadline, headed};

#[test]
fn quick_settings_refusal_names_build_and_capability_holder() {
    let error = open_surface(SnapshotSurface::QuickSettings, headed(), deadline(5_000))
        .expect_err("quick-settings is absent on this build");

    assert_eq!(error.code, ErrorCode::PlatformNotSupported);
    let build = build_number();
    assert!(build > 0, "the build number must be read, not guessed");
    let detail = error.platform_detail.expect("the refusal carries a detail");
    assert!(
        detail.contains(&build.to_string()),
        "the detail must name the build: {detail}"
    );
    assert!(
        detail.contains("action-center"),
        "the detail must name the surface carrying the capability: {detail}"
    );
}

#[test]
fn kind_pointed_at_an_absent_class_times_out() {
    let row = SurfaceKindRow {
        kind: SnapshotSurface::Desktop,
        family: SurfaceFamily::Win32Class(&["NoAgentDesktopShellSurfaceClass"]),
        raise: SurfaceRaise::AlreadyRaised,
        dismiss: SurfaceDismiss::None,
        exists_on_build: true,
        capability_holder: None,
    };

    let error = open_row(&row, deadline(1_500)).expect_err("no window has the class");

    assert_eq!(error.code, ErrorCode::Timeout);
    assert_ne!(
        error.code,
        ErrorCode::PlatformNotSupported,
        "did not open is a different answer than absent on this build"
    );
}

/// The notification area is reached by descending a class chain, and three
/// `ToolbarWindow32` windows sit under `Shell_TrayWnd` on this shell. Two are
/// collapsed placeholders with zero extent whose automation elements have no
/// children; only the one parented by `SysPager` holds the promoted icons
/// (A28-4). A chain that stops at `TrayNotifyWnd` therefore resolves a real,
/// live, visible-flagged window and reads zero items - a failure that looks
/// exactly like an empty tray. This pins the hop that tells them apart, which
/// no live assertion can do on a machine whose tray may legitimately be empty.
#[test]
fn the_system_tray_chain_descends_through_the_pager_that_owns_the_icons() {
    let row = row_for(SnapshotSurface::SystemTray).expect("system-tray is a known surface kind");
    let SurfaceFamily::Win32Class(chain) = row.family else {
        panic!("the system tray is reached by class chain, not by another family");
    };

    assert_eq!(
        chain,
        &[
            SHELL_TRAY_WND_CLASS,
            TRAY_NOTIFY_CLASS,
            SYS_PAGER_CLASS,
            TOOLBAR_CLASS,
        ],
        "the measured chain to the toolbar that owns the promoted icons"
    );
    let pager = chain
        .iter()
        .position(|class| *class == SYS_PAGER_CLASS)
        .expect("the pager hop is what distinguishes the icon toolbar from its placeholders");
    let toolbar = chain
        .iter()
        .position(|class| *class == TOOLBAR_CLASS)
        .expect("the chain ends at a toolbar");
    assert!(
        pager < toolbar,
        "the pager must be the toolbar's parent, not a later hop"
    );
}

/// The raise-then-Escape dismissal re-runs the row's own raise before sending
/// the key, so it is only sound for a raise that presents idempotently. The
/// chevron invoke measures that way - it toggles a presented flyout closed and
/// activates one that is merely visible, and either outcome ends in a closed
/// surface. An accelerator raise does not: re-sending it can raise the surface
/// the close was asked to dismiss. Pinned in the table rather than at the call
/// site, because the table is where a future row would get this wrong.
#[test]
fn raise_then_escape_rows_all_raise_by_chevron_invoke() {
    for row in KINDS {
        if row.dismiss != SurfaceDismiss::RaiseThenEscape {
            continue;
        }
        assert!(
            matches!(row.raise, SurfaceRaise::ChevronInvoke),
            "'{}' dismisses by re-raising, which needs an idempotent raise",
            crate::system::shell::shell_surface::kebab(row.kind)
        );
    }
}

/// The overflow is the row that carries the measured dismissal, and a table
/// that silently moved it back to a bare Escape would put the close path back
/// to sending a keystroke at a surface that may not be able to receive it.
#[test]
fn the_overflow_dismisses_by_raising_before_the_escape() {
    let row = row_for(SnapshotSurface::SystemTrayOverflow).expect("the overflow is a known kind");

    assert_eq!(
        row.dismiss,
        SurfaceDismiss::RaiseThenEscape,
        "a bare Escape is delivered to the foreground, not to the overflow"
    );
}

#[test]
fn a_shell_host_image_matches_by_stem_and_an_application_does_not() {
    use crate::system::shell::shell_surface_immersive::is_host_image;

    assert!(is_host_image("SearchHost.exe", START_HOSTS));
    assert!(is_host_image("StartMenuExperienceHost.exe", START_HOSTS));
    assert!(!is_host_image("notepad.exe", START_HOSTS));
    assert!(!is_host_image("searchhostx.exe", START_HOSTS));
}
