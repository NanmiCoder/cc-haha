//! Surface-root resolution tests: the per-surface match arms, and the live
//! advertise/resolve/emit equality the shell kinds and `Menu` were added
//! under.
//!
//! The shell-surface legs hold `test_support::SHELL_SURFACE_LOCK` - the same
//! lock `system::shell_surface_tests` holds - because the surfaces they open
//! are machine-global: a concurrently running test that dismisses or raises
//! the Action Center would resolve a surface this file had already
//! dismissed. Fixture legs hold `FIXTURE_APP_NAME_LOCK` for the fixture's
//! lifetime per that lock's own contract; where a test takes both, the
//! fixture lock is taken first, matching the crate-wide ordering.

use super::*;

#[cfg(target_os = "windows")]
#[test]
fn a_malformed_window_id_is_rejected_before_the_platform_is_reached() {
    let error = parse_window_id("not-a-window").expect_err("must reject");
    assert_eq!(error.code, ErrorCode::InvalidArgs);
}

/// `window_is_modal_sheet` reads the property with no provider; an absent
/// or unknown read is not a sheet.
#[cfg(not(target_os = "windows"))]
#[test]
fn an_absent_window_modal_read_is_not_a_sheet() {
    use super::super::element::{CannedElement, UIAElement};
    let element = UIAElement::from(CannedElement);
    assert!(!window_is_modal_sheet(&element));
}

/// The shipped predicate, on the lane that runs it.
///
/// The non-Windows arm above drives a stub whose body is `false`, so it
/// answers correctly for its own reasons and says nothing about the real
/// read. This drives the real one against a live top-level window that is
/// not modal, and asserts the provider's own answer first: with the
/// provider confirmed to be reporting `false`, a predicate that ignored
/// the read or inverted its comparison would classify an ordinary window
/// as a `Sheet` surface and fail here.
#[cfg(target_os = "windows")]
#[test]
fn a_live_non_modal_window_is_not_classified_as_a_sheet() {
    use super::super::fixture::{HostedFixture, ensure_test_apartment};
    use super::super::walk::walker_fake::deadline;

    ensure_test_apartment();
    let fixture = HostedFixture::spawn().expect("the fixture spawns");
    let root = root_from_hwnd(fixture.handle(), deadline()).expect("the fixture window roots");

    assert_eq!(
        read_one(&root, TreeProperty::WindowIsModal).flag(),
        Some(false),
        "the provider must answer this read for the classification below to be tested"
    );
    assert!(!window_is_modal_sheet(&root));
}

#[cfg(all(test, target_os = "windows"))]
mod shell_surfaces {
    use super::*;

    use super::super::super::fixture::fixture_modal::ModalFixture;
    use super::super::super::fixture::{HostedFixture, bootstrap};
    use super::super::super::walk::walker_fake::deadline;
    use crate::adapter::WindowsAdapter;
    use crate::system::fixture::test_support::{
        SHELL_SURFACE_LOCK, or_skip_shell, shell_declined_the_surface, stage_foreground,
        wait_for_foreground_to_settle,
    };
    use crate::system::shell::raise_oracle::{responded_since, witness_desktop};
    use crate::system::shell::shell_surface::resolve_surface;
    use crate::system::shell::shell_surface_open::{close_surface, open_surface};
    use crate::tree::fixture::fixture_menu::MenuFixture;
    use crate::tree::fixture::fixture_window;
    use crate::tree::test_support::rooted_child_count;
    use agent_desktop_core::{InteractionPolicy, ObservationOps, ProcessId, SystemOps, WindowInfo};
    use std::time::Duration;

    const STATE_TIMEOUT: Duration = Duration::from_secs(5);

    /// Finally-style cleanup: whatever a test raised is dismissed when the
    /// test body exits, on any path, so a failed assertion never leaks a
    /// raised surface into the next test.
    struct CloseOnDrop(SnapshotSurface);

    impl Drop for CloseOnDrop {
        fn drop(&mut self) {
            let _ = close_surface(self.0, deadline());
        }
    }

    /// Builds the identity a surface root consumes from a live window: the
    /// surface arms read the handle-shaped id and, for `Menu`, the pid.
    fn window_info(handle: isize, pid: u32) -> WindowInfo {
        WindowInfo {
            id: format!("w-{handle}"),
            title: String::new(),
            app: String::new(),
            pid: ProcessId::from(pid),
            process_instance: None,
            bounds: None,
            state: Default::default(),
        }
    }

    /// The resolution assertion: the advertised kind roots through its own
    /// `surface_root` arm. A stub arm answering `WINDOW_NOT_FOUND`, or an
    /// advertised kind with no arm at all, fails here - that is the property
    /// the advertise/resolve equality exists to enforce.
    fn assert_roots(kind: SnapshotSurface, info: &WindowInfo) {
        surface_root(ObservationRoot::Window(info), kind, deadline()).unwrap_or_else(|error| {
            panic!(
                "advertised surface '{}' did not resolve through its arm: {error:?}",
                kind.as_str()
            )
        });
    }

    /// [`assert_roots`] plus the tree being non-empty, for the surfaces whose
    /// content is stable while present. The notification-area toolbars are
    /// excluded: how many tray icons are promoted is desktop state, so their
    /// root element is legitimately childless while still rootable.
    fn assert_roots_non_empty(kind: SnapshotSurface, info: &WindowInfo) {
        let root =
            surface_root(ObservationRoot::Window(info), kind, deadline()).unwrap_or_else(|error| {
                panic!(
                    "advertised surface '{}' did not resolve through its arm: {error:?}",
                    kind.as_str()
                )
            });
        assert!(
            rooted_child_count(&root) > 0,
            "advertised surface '{}' rooted an empty tree",
            kind.as_str()
        );
    }

    /// An open shell surface resolves through the adapter seam into the
    /// identity the observation stack roots, whether or not this process
    /// raised it - the resolution the app-less `snapshot --surface` path is
    /// built on, asserted against a surface raised by `open_surface` and
    /// rooted through `root_from_hwnd` with a non-empty tree, since an
    /// identity nothing can observe is not a resolution.
    #[test]
    fn an_open_shell_surface_resolves_through_the_adapter_seam_and_roots_a_tree() {
        bootstrap();
        let _lock = SHELL_SURFACE_LOCK.lock().unwrap_or_else(|e| e.into_inner());
        let _stage = fixture_window::on_screen_stage();
        let _ = close_surface(SnapshotSurface::ActionCenter, deadline());
        let _cleanup = CloseOnDrop(SnapshotSurface::ActionCenter);
        let witness = witness_desktop();

        let Some(raised) = or_skip_shell(
            "action center open",
            open_surface(
                SnapshotSurface::ActionCenter,
                InteractionPolicy::headed(),
                deadline(),
            ),
            || responded_since(&witness),
        ) else {
            return;
        };
        let resolved = ObservationOps::resolve_shell_surface(
            &WindowsAdapter::new(),
            SnapshotSurface::ActionCenter,
            deadline(),
        )
        .expect("an open surface resolves through the trait");
        assert_eq!(resolved.id, raised.id);

        let handle = resolved
            .id
            .strip_prefix("w-")
            .and_then(|digits| digits.parse::<isize>().ok())
            .expect("a shell surface id is a w-<hwnd> handle");
        let root =
            root_from_hwnd(handle, deadline()).expect("the identity roots through the stack");
        assert!(
            rooted_child_count(&root) > 0,
            "the resolved surface presents a non-empty tree"
        );
    }

    /// A closed surface is not the application-window "window not found,
    /// retry or fall back to --app" - neither can work for a surface no
    /// application owns - so the error's suggestion is the assertion: it
    /// names the command that raises the surface.
    #[test]
    fn a_closed_shell_surface_names_how_to_open_it() {
        bootstrap();
        let _lock = SHELL_SURFACE_LOCK.lock().unwrap_or_else(|e| e.into_inner());
        let _stage = fixture_window::on_screen_stage();
        close_surface(SnapshotSurface::ActionCenter, deadline())
            .expect("the action center dismisses");

        let error = ObservationOps::resolve_shell_surface(
            &WindowsAdapter::new(),
            SnapshotSurface::ActionCenter,
            deadline(),
        )
        .expect_err("a dismissed surface must not resolve");

        assert_eq!(error.code, ErrorCode::WindowNotFound);
        let suggestion = error.suggestion.expect("the error carries a suggestion");
        assert!(
            suggestion.contains("open-system-surface"),
            "the suggestion must name the command that raises the surface: {suggestion}"
        );
        assert!(
            suggestion.contains("action-center"),
            "the suggestion must name the requested kind: {suggestion}"
        );
    }

    /// R4's advertised-equals-resolvable leg, proven against live surfaces:
    /// every advertised kind is staged - fixtures for the window-family
    /// surfaces, the shell's own state for the chrome kinds, the fixture's
    /// open context menu for `Menu` - and roots through its own arm. The menu
    /// leg runs last: raising shell chrome sends the menu's owner
    /// `WM_CANCELMODE`, so an open fixture menu cannot survive the chrome
    /// legs staged before it. A leg whose precondition the OS declines (the
    /// foreground, which `SetForegroundWindow` grants only advisory, or a
    /// shell kind whose raise the desktop's shell declines instead of
    /// presenting) skips loudly and is exempted from the coverage
    /// requirement, the same concession `stage_foreground`'s own contract
    /// documents.
    #[test]
    fn every_advertised_surface_resolves_to_a_rootable_element_when_present() {
        bootstrap();
        let _fixture_scope = crate::system::fixture::test_support::FIXTURE_APP_NAME_LOCK
            .lock()
            .unwrap_or_else(|e| e.into_inner());
        let _lock = SHELL_SURFACE_LOCK.lock().unwrap_or_else(|e| e.into_inner());
        let advertised = WindowsAdapter::new().supported_surfaces();
        let mut covered: Vec<SnapshotSurface> = Vec::new();
        let mut skipped: Vec<SnapshotSurface> = Vec::new();

        {
            let hosted = HostedFixture::spawn().expect("the hosted fixture spawns");
            let info = window_info(hosted.handle(), hosted.process_id());
            if advertised.contains(&SnapshotSurface::Window) {
                assert_roots_non_empty(SnapshotSurface::Window, &info);
                covered.push(SnapshotSurface::Window);
            }
            let focused_staged = stage_foreground(hosted.handle());
            if focused_staged && advertised.contains(&SnapshotSurface::Focused) {
                assert_roots_non_empty(SnapshotSurface::Focused, &info);
                covered.push(SnapshotSurface::Focused);
            } else if advertised.contains(&SnapshotSurface::Focused) {
                eprintln!("skip focused leg: the OS declined the fixture window the foreground");
                skipped.push(SnapshotSurface::Focused);
            }
        }
        {
            let modal = ModalFixture::spawn().expect("the modal fixture spawns");
            modal.open();
            assert!(modal.wait_for_modal_state(true, STATE_TIMEOUT));
            if stage_foreground(modal.modal_handle()) {
                assert_roots_non_empty(
                    SnapshotSurface::Sheet,
                    &window_info(modal.modal_handle(), modal.process_id()),
                );
                covered.push(SnapshotSurface::Sheet);
            } else {
                eprintln!("skip sheet leg: the OS declined the modal window the foreground");
                skipped.push(SnapshotSurface::Sheet);
            }
        }
        stage_and_assert_shell_kinds(&advertised, &mut covered, &mut skipped);
        stage_and_assert_menu(&advertised, &mut covered);

        for kind in &advertised {
            if skipped.contains(kind) {
                eprintln!(
                    "advertised surface '{}' skipped: its precondition was declined, \
                     so this run does not prove its resolvability",
                    kind.as_str()
                );
                continue;
            }
            assert!(
                covered.contains(kind),
                "advertised surface '{}' was never staged live, so the \
                 advertise/resolve equality is unproven for it",
                kind.as_str()
            );
        }
    }

    fn stage_and_assert_shell_kinds(
        advertised: &[SnapshotSurface],
        covered: &mut Vec<SnapshotSurface>,
        skipped: &mut Vec<SnapshotSurface>,
    ) {
        assert!(
            wait_for_foreground_to_settle(),
            "the desktop's foreground must settle before the shell kinds are staged"
        );
        let _stage = fixture_window::on_screen_stage();
        let mut raised: Vec<SnapshotSurface> = Vec::new();
        for kind in [
            SnapshotSurface::Taskbar,
            SnapshotSurface::SystemTray,
            SnapshotSurface::SystemTrayOverflow,
            SnapshotSurface::StartMenu,
            SnapshotSurface::ActionCenter,
        ] {
            if !advertised.contains(&kind) {
                continue;
            }
            let already_up = resolve_surface(kind, deadline())
                .expect("the desktop is readable")
                .is_some();
            let info = match already_up {
                true => resolve_surface(kind, deadline())
                    .expect("the desktop is readable")
                    .expect("checked above"),
                false => {
                    let witness = witness_desktop();
                    let Some(info) = or_skip_shell(
                        &format!("staging advertised surface '{}'", kind.as_str()),
                        open_surface(kind, InteractionPolicy::headed(), deadline()),
                        || responded_since(&witness),
                    ) else {
                        skipped.push(kind);
                        continue;
                    };
                    raised.push(kind);
                    info
                }
            };
            assert_roots(kind, &info);
            covered.push(kind);
        }
        for kind in raised.iter().rev() {
            if let Err(error) = close_surface(*kind, deadline()) {
                if shell_declined_the_surface(&error) {
                    eprintln!(
                        "skip closing advertised surface '{}': the shell accepted the \
                         raise but declined the dismiss ({error:?})",
                        kind.as_str()
                    );
                    skipped.push(*kind);
                    continue;
                }
                panic!("cleanup of '{kind:?}' failed: {error:?}");
            }
        }
    }

    fn stage_and_assert_menu(advertised: &[SnapshotSurface], covered: &mut Vec<SnapshotSurface>) {
        if !advertised.contains(&SnapshotSurface::Menu) {
            return;
        }
        let _stage = fixture_window::on_screen_stage();
        let menu = MenuFixture::spawn().expect("the menu fixture spawns");
        menu.open_context_menu();
        assert!(menu.wait_for_menu_state(true, STATE_TIMEOUT));

        assert_roots_non_empty(
            SnapshotSurface::Menu,
            &window_info(menu.handle(), menu.process_id()),
        );
        covered.push(SnapshotSurface::Menu);

        menu.dismiss_context_menu();
        assert!(menu.wait_for_menu_state(false, STATE_TIMEOUT));
    }
}
