use agent_desktop_core::ErrorCode;

use super::fake::*;
use super::*;
use crate::system::x11::twin_tie::Twins;

#[test]
fn a_window_already_active_by_both_measures_sends_nothing() {
    let world = World::new(Some(CLIENT));
    run(&world, &window(), budget()).expect("already active is a success");
    assert_eq!(world.sends(), 0);
}

#[test]
fn a_grant_that_arrives_after_some_polls_is_still_a_success() {
    let mut world = World::new(Some(OTHER));
    world.grant = Grant::AfterReads(3);
    run(&world, &window(), budget()).expect("the wait polls rather than checking once");
    assert_eq!(*world.sent.borrow(), vec![CLIENT]);
    assert!(world.active_reads.get() >= 3);
}

#[test]
fn an_unmapped_window_is_refused_before_any_send() {
    let mut world = World::new(Some(OTHER));
    world.flags.mapped = false;
    assert_refused(&failure(&world), "window_not_mapped");
    let mut none = World::new(Some(OTHER));
    none.state = X11State::Ready {
        active: Some(OTHER),
        clients: Vec::new(),
    };
    assert_refused(&failure(&none), "window_not_mapped");
    assert_eq!(world.sends() + none.sends(), 0);
}

#[test]
fn an_ambiguous_mapping_is_refused_before_any_send() {
    let mut world = World::new(Some(OTHER));
    world.global = false;
    world.state = X11State::Ready {
        active: Some(OTHER),
        clients: vec![x11_client(CLIENT, "Doc"), x11_client(CLIENT + 1, "Doc")],
    };
    assert_refused(&failure(&world), "ambiguous_window");
    assert_eq!(world.sends(), 0);
}

fn twin_world(active: u32, twins: Twins) -> World {
    let mut world = World::new(Some(active));
    world.global = false;
    world.state = X11State::Ready {
        active: Some(active),
        clients: vec![x11_client(CLIENT, "Doc"), x11_client(CLIENT + 1, "Doc")],
    };
    world.frame_active.set(Some(twins.active[twins.me]));
    world.twins = Some(twins);
    world
}

#[test]
fn the_inactive_twin_is_the_other_client_and_is_activated() {
    let world = twin_world(
        CLIENT + 1,
        Twins {
            active: vec![false, true],
            me: 0,
        },
    );
    run(&world, &window(), budget()).expect("the other client answers to this window");
    assert_eq!(*world.sent.borrow(), vec![CLIENT]);
}

#[test]
fn the_active_twin_is_already_focused_and_sends_nothing() {
    let world = twin_world(
        CLIENT,
        Twins {
            active: vec![true, false],
            me: 0,
        },
    );
    run(&world, &window(), budget()).expect("the active client is this window");
    assert_eq!(world.sends(), 0);
}

#[test]
fn a_tie_the_twins_cannot_break_is_refused_before_any_send() {
    for active in [vec![false, false], vec![true, true]] {
        let world = twin_world(CLIENT + 1, Twins { active, me: 0 });
        assert_refused(&failure(&world), "ambiguous_window");
        assert_eq!(world.sends(), 0);
    }
}

#[test]
fn wayland_no_display_and_no_manager_are_refused_before_any_send() {
    let mut wayland = World::new(Some(OTHER));
    wayland.session = Session::Wayland;
    let refused = failure(&wayland);
    assert_eq!(refused.code, ErrorCode::ActionNotSupported);
    assert_eq!(
        refused.details.as_ref().expect("details")["cause"],
        "wayland_session"
    );
    assert_eq!(
        refused.disposition,
        agent_desktop_core::DeliverySemantics::not_delivered()
    );
    let mut none = World::new(Some(OTHER));
    none.session = Session::NoDisplay;
    assert_eq!(failure(&none).code, ErrorCode::PlatformNotSupported);
    let mut bare = World::new(Some(OTHER));
    bare.state = X11State::NoWindowManager;
    assert_refused(&failure(&bare), "no_window_manager");
    let mut dark = World::new(Some(OTHER));
    dark.state = X11State::Unavailable;
    assert_eq!(failure(&dark).code, ErrorCode::Timeout);
    assert_eq!(
        wayland.sends() + none.sends() + bare.sends() + dark.sends(),
        0
    );
}

#[test]
fn an_open_menu_of_the_active_app_is_focus_without_another_request() {
    let mut world = World::new(Some(CLIENT));
    world.frame_active.set(Some(false));
    world.menu_open = true;
    run(&world, &window(), budget()).expect("the menu's grab is the application's focus");
    assert_eq!(world.sends(), 0);
}

#[test]
fn a_chromium_popup_active_frame_proves_focus_only_when_its_app_owns_the_x11_client() {
    let mut app_owned = World::new(Some(CLIENT));
    app_owned.frame_active.set(Some(false));
    app_owned.app_frame_active = true;
    run(&app_owned, &window(), budget()).expect("the active popup belongs to this app");
    assert_eq!(app_owned.sends(), 0);

    let mut foreign = World::new(Some(OTHER));
    foreign.grant = Grant::Never;
    foreign.frame_active.set(Some(false));
    foreign.app_frame_active = true;
    assert_refused(&failure(&foreign), "activation_refused");
    assert_eq!(foreign.active.get(), Some(OTHER));
}

#[test]
fn another_process_instance_ends_the_ref_before_any_send() {
    let mut world = World::new(Some(OTHER));
    let mut changed = facts();
    changed.instance = "ffff0000:1".to_owned();
    world.lookup = Lookup::Found(changed);
    assert_eq!(failure(&world).code, ErrorCode::StaleRef);
    world.lookup = Lookup::Gone;
    assert_eq!(failure(&world).code, ErrorCode::StaleRef);
    assert_eq!(world.sends(), 0);
}

#[test]
fn an_unreadable_process_is_neither_gone_nor_changed_so_focus_goes_on() {
    let mut world = World::new(Some(OTHER));
    world.lookup = Lookup::Unreadable;
    run(&world, &window(), budget()).expect("an unreadable process does not end the ref");
    assert_eq!(world.sends(), 1);
}

#[test]
fn a_window_id_of_another_format_is_refused_before_any_send() {
    let world = World::new(Some(OTHER));
    let mut foreign = window();
    foreign.id = "0x400003".to_owned();
    let error = run(&world, &foreign, budget()).expect_err("a foreign id is refused");
    assert_eq!(error.code, ErrorCode::InvalidArgs);
    assert_eq!(world.sends(), 0);
}

#[path = "focus_overview_tests.rs"]
mod overview;

#[path = "focus_window_grace_tests.rs"]
mod grace;
