//! The advertise/resolve/emit equality's third leg, and the two-questions
//! design for a kind this build does not root.
//!
//! `every_advertised_surface_resolves_to_a_rootable_element_when_present`
//! proves advertised implies resolvable against live surfaces, and
//! `every_signal_emittable_surface_kind_is_advertised` proves emit implies
//! advertised. This module owns the remaining direction - resolvable implies
//! advertised - plus the deliberate absence of `QuickSettings` from the
//! advertised set.

use super::*;

use crate::adapter::WindowsAdapter;
use crate::tree::walk::walker_fake::deadline;
use agent_desktop_core::{ProcessId, SystemOps, WindowInfo};

/// The kinds the Windows `surface_root` match resolves, enumerated by hand
/// from the match arms. The list is deliberately explicit rather than
/// derived: deriving it would mean probing `surface_root` against live
/// desktop state to answer a structural question, and a run-time derivation
/// cannot see an arm whose only caller would be an unadvertised kind. An
/// explicit list makes that landing visible instead - a new arm forces this
/// list to grow in the same diff, and the diff forces the advertise question
/// to be answered. A stale list that omits a kind is exactly the erosion
/// this leg exists to catch.
const SURFACE_ROOT_RESOLVABLE: &[SnapshotSurface] = &[
    SnapshotSurface::Window,
    SnapshotSurface::Focused,
    SnapshotSurface::Sheet,
    SnapshotSurface::Menu,
    SnapshotSurface::StartMenu,
    SnapshotSurface::Taskbar,
    SnapshotSurface::SystemTray,
    SnapshotSurface::SystemTrayOverflow,
    SnapshotSurface::ActionCenter,
];

/// Resolvable implies advertised: every kind an observation can root through
/// `surface_root` is one core's advertise check admits, so `snapshot
/// --surface` can never resolve a kind it first refuses.
#[test]
fn every_surface_root_resolvable_kind_is_advertised() {
    let advertised = WindowsAdapter::new().supported_surfaces();
    for kind in SURFACE_ROOT_RESOLVABLE {
        assert!(
            advertised.contains(kind),
            "surface_root resolves '{}' but the adapter does not advertise it",
            kind.as_str()
        );
    }
}

/// Emitted implies advertised: every kind the signal baseline can
/// construct is in `supported_surfaces()`, so `wait --event
/// surface-appeared` can never legitimately report a surface that
/// `snapshot --surface` refuses.
#[test]
fn every_signal_emittable_surface_kind_is_advertised() {
    use crate::system::signal::signal_surfaces::SIGNAL_SURFACE_KINDS;

    let advertised = WindowsAdapter::new().supported_surfaces();
    for kind in SIGNAL_SURFACE_KINDS {
        assert!(
            advertised.contains(kind),
            "the signal path can emit '{}' but the adapter does not advertise it",
            kind.as_str()
        );
    }
}

/// The two-questions design, pinned on the kind this build answers "no" to:
/// the kind table carries a `QuickSettings` row, so open-system-surface
/// refuses it with the build-shaped answer rather than "unknown kind" - but
/// this build keeps the quick actions inside the Action Center pane, so the
/// adapter does not advertise it and `surface_root` has no arm for it. A
/// request must refuse in core, never root into a surface this adapter
/// cannot resolve.
#[test]
fn quick_settings_is_a_kind_table_refusal_and_never_an_advertised_surface() {
    let advertised = WindowsAdapter::new().supported_surfaces();
    assert!(
        !advertised.contains(&SnapshotSurface::QuickSettings),
        "quick-settings must not be advertised: this build carries the quick \
         actions inside the action-center surface"
    );

    let refusal = match surface_root(
        ObservationRoot::Window(&unrootable_window_info()),
        SnapshotSurface::QuickSettings,
        deadline(),
    ) {
        Ok(_) => panic!(
            "a surface_root arm for quick-settings resolved an identity without the \
             adapter advertising the kind"
        ),
        Err(refusal) => refusal,
    };
    assert_eq!(
        refusal.code,
        ErrorCode::PlatformNotSupported,
        "a surface_root arm for quick-settings landed without being advertised"
    );
}

/// A well-formed identity the arm probe can carry. The catch-all arm never
/// reads it; if an arm ever landed, a handle that addresses no window fails
/// fast instead of touching the desktop.
fn unrootable_window_info() -> WindowInfo {
    WindowInfo {
        id: "w-2147483647".to_string(),
        title: String::new(),
        app: String::new(),
        pid: ProcessId::from(0),
        process_instance: None,
        bounds: None,
        state: Default::default(),
    }
}
