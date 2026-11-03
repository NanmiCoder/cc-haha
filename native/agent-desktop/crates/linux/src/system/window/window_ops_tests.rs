use agent_desktop_core::{ErrorCode, WindowInfo, WindowState};

use super::require_answered;
use crate::system::registry::app_outcome::AppOutcome;
use crate::system::registry::listed_window::ListedWindow;
use crate::system::registry::registry_frames::RootRead;
use crate::system::signal::signal_inventory::pass_over_with_menu;
use crate::system::x11::{FrameExtents, FrameFacts, X11Client, X11State};

fn window(title: &str, active: bool, modal: bool) -> ListedWindow {
    ListedWindow {
        app: 0,
        info: WindowInfo {
            id: format!("w-1.1-{title}"),
            title: title.to_owned(),
            app: "a".to_owned(),
            pid: 7.into(),
            process_instance: Some("i".to_owned()),
            bounds: None,
            state: WindowState::default(),
        },
        active,
        modal,
        dialog: false,
        frame: FrameFacts {
            size_identity: false,
            pid: 7,
            title: title.to_owned(),
            extents: None,
            global_position: true,
        },
        sheet: false,
        unshown: false,
    }
}

fn client(id: u32, title: &str) -> X11Client {
    X11Client {
        shadow: (0, 0, 0, 0),
        id,
        pid: Some(7),
        title: title.to_owned(),
        extents: None::<FrameExtents>,
        bounds: None,
        hidden: false,
    }
}

fn state(active: u32) -> X11State {
    X11State::Ready {
        active: Some(active),
        clients: vec![client(1, "main"), client(2, "dialog")],
    }
}

fn focused(
    listed: Vec<ListedWindow>,
    state: &X11State,
    input_focus_in: impl Fn(u32) -> bool,
) -> Option<usize> {
    pass_over_with_menu(
        listed,
        Vec::new(),
        Vec::new(),
        state,
        |_| Ok(false),
        input_focus_in,
    )
    .focused
}

#[test]
fn a_modal_frame_that_never_reports_active_is_focused_when_the_display_and_input_focus_name_it() {
    let listed = vec![window("main", false, false), window("dialog", false, true)];
    assert_eq!(focused(listed, &state(2), |_| true), Some(1));
}

#[test]
fn a_dialog_frame_the_display_does_not_name_is_not_focused() {
    let mut dialog = window("dialog", false, false);
    dialog.dialog = true;
    let listed = vec![window("main", false, false), dialog];
    assert_eq!(focused(listed, &state(1), |_| false), None);
}

#[test]
fn a_modal_frame_the_display_does_not_name_is_not_focused() {
    let listed = vec![window("main", false, false), window("dialog", false, true)];
    assert_eq!(focused(listed, &state(1), |_| false), None);
}

#[test]
fn a_frame_that_is_not_modal_and_not_active_is_never_focused_by_the_display_alone() {
    let listed = vec![window("main", false, false), window("dialog", false, false)];
    assert_eq!(focused(listed, &state(2), |_| true), None);
}

#[test]
fn an_inactive_dialog_needs_positive_input_focus_evidence() {
    for modal in [false, true] {
        let mut dialog = window("dialog", false, modal);
        dialog.dialog = true;
        let listed = vec![window("main", false, false), dialog];
        assert_eq!(focused(listed.clone(), &state(2), |_| false), None);
        assert_eq!(focused(listed.clone(), &state(2), |id| id == 2), Some(1));
        assert_eq!(focused(listed, &state(2), |id| id == 1), None);
    }
}

fn outcome(read: RootRead) -> Vec<AppOutcome> {
    vec![AppOutcome { app: 0, read }]
}

#[test]
fn a_named_application_that_left_a_frame_unanswered_and_listed_nothing_is_a_timeout() {
    let error = require_answered(Vec::new(), &outcome(RootRead::TimedOut), true)
        .expect_err("an empty list must not read as a closed window");
    assert_eq!(error.code, ErrorCode::Timeout);
}

#[test]
fn an_empty_list_stays_empty_when_every_frame_answered_or_no_application_was_named() {
    assert!(
        require_answered(Vec::new(), &outcome(RootRead::Read), true)
            .expect("an answered read stays empty")
            .is_empty()
    );
    assert!(
        require_answered(Vec::new(), &outcome(RootRead::TimedOut), false)
            .expect("an unnamed listing stays empty")
            .is_empty()
    );
}

#[test]
fn the_windows_that_did_answer_are_listed_beside_an_unanswered_frame() {
    let listed = vec![window("main", false, false)];
    let kept = require_answered(listed, &outcome(RootRead::TimedOut), true)
        .expect("the answered windows are kept");
    assert_eq!(kept.len(), 1);
}
