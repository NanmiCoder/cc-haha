use std::time::{Duration, Instant};

use agent_desktop_core::{ErrorCode, ProcessIdentity, SystemOps, WindowFilter};

use super::signal_live_apps::{
    Rig, Stopped, capture, count_of, deadline, details_of, diff, dismiss_dialog, found_event,
    identity_of, launch_qt, open_gtk4_menu_item, outcome, poll, process_state, tokens, top_level,
    wait_event, x11_windows,
};
use crate::system::list_windows;

const OPEN_MS: u64 = 15_000;

fn calculator(rig: &mut Rig) -> (u32, String, ProcessIdentity) {
    let pid = rig.spawn("gnome-calculator", &[]);
    poll("the calculator window", || {
        (x11_windows(pid).len() == 1).then_some(())
    });
    let (name, identity) = identity_of(rig, pid);
    (pid, name, identity)
}

fn dialog_case(rig: &Rig, pid: u32, app: &str, identity: &ProcessIdentity, open: impl Fn(&Rig)) {
    let before = top_level(&rig.connection, pid).len();
    let seed = capture(rig, Some(app), Some(identity), 10_000).expect("the seed capture");
    open(rig);
    poll("the dialog to join the top level", || {
        (top_level(&rig.connection, pid).len() > before).then_some(())
    });
    let result = wait_event(
        rig,
        "surface-appeared",
        Some(app),
        OPEN_MS,
        Some(Ok(seed.clone())),
    );
    assert_eq!(
        found_event(&result)["surface"],
        "sheet",
        "{}",
        outcome(&result)
    );
    let after = capture(rig, Some(app), Some(identity), 10_000).expect("capture");
    let events = diff(&seed, &after);
    assert_eq!(
        (
            count_of(&events, "surface-appeared"),
            count_of(&events, "window-opened")
        ),
        (1, 1),
        "{:?}",
        tokens(&events)
    );
    let sheet = after.surfaces.first().expect("a sheet signal");
    let window = after
        .windows
        .iter()
        .find(|w| w.id == sheet.id)
        .expect("the sheet carries a listed window's id");
    assert!(seed.windows.iter().all(|w| w.id != window.id));
    dismiss_dialog(rig, app, pid, before);
    let result = wait_event(
        rig,
        "surface-dismissed",
        Some(app),
        OPEN_MS,
        Some(Ok(after.clone())),
    );
    assert_eq!(
        found_event(&result)["surface"],
        "sheet",
        "{}",
        outcome(&result)
    );
    let closed = capture(rig, Some(app), Some(identity), 10_000).expect("capture");
    let events = diff(&after, &closed);
    assert_eq!(
        (
            count_of(&events, "surface-dismissed"),
            count_of(&events, "window-closed")
        ),
        (1, 1),
        "{:?}",
        tokens(&events)
    );
}

#[test]
#[ignore = "drives real desktop applications; run through scripts/private-session.sh --wm"]
fn signal_live_gtk4_about_dialog_is_a_sheet_by_identity() {
    let mut rig = Rig::new();
    let (pid, app, identity) = calculator(&mut rig);
    dialog_case(&rig, pid, &app, &identity, |rig| {
        open_gtk4_menu_item(rig, pid, 1)
    });
}

#[test]
#[ignore = "drives real desktop applications; run through scripts/private-session.sh --wm"]
fn signal_live_gtk4_keyboard_shortcuts_unnamed_panel_is_a_sheet_by_identity() {
    let mut rig = Rig::new();
    let (pid, app, identity) = calculator(&mut rig);
    dialog_case(&rig, pid, &app, &identity, |rig| {
        open_gtk4_menu_item(rig, pid, 3)
    });
}

#[test]
#[ignore = "drives real desktop applications; run through scripts/private-session.sh --wm"]
fn signal_live_stopped_target_scoped_wait_answers_app_unresponsive_at_once() {
    let mut rig = Rig::new();
    let (pid, app, identity) = calculator(&mut rig);
    capture(&rig, Some(&app), Some(&identity), 10_000).expect("an alive target captures");
    let _stopped = Stopped::new(pid);
    poll("the process to stop", || {
        (process_state(pid) == Some('T')).then_some(())
    });
    let started = Instant::now();
    let seed = capture(&rig, Some(&app), Some(&identity), 10_000);
    let error = seed
        .as_ref()
        .expect_err("a stopped scoped target is an error");
    assert_eq!(error.code, ErrorCode::AppUnresponsive);
    assert!(
        started.elapsed() < Duration::from_secs(5),
        "{:?}",
        started.elapsed()
    );

    let started = Instant::now();
    let result = wait_event(&rig, "window-opened", Some(&app), 3_000, Some(seed));
    let elapsed = started.elapsed();
    let error = result.expect_err("a stopped scoped target ends the wait");
    assert_eq!(error.code(), ErrorCode::AppUnresponsive.as_str());
    assert!(elapsed < Duration::from_secs(3), "{elapsed:?}");
}

#[test]
#[ignore = "drives real desktop applications; run through scripts/private-session.sh --wm"]
fn signal_live_window_taken_before_a_stop_resolves_to_app_unresponsive() {
    let mut rig = Rig::new();
    let (pid, _, _) = calculator(&mut rig);
    let filter = WindowFilter {
        focused_only: false,
        app: None,
    };
    let windows = list_windows(rig.bus(), &filter, deadline(10_000)).expect("windows");
    let target = windows.iter().find(|w| w.pid == pid).expect("a window");
    let resolved = rig.adapter.resolve_window_strict(target, deadline(10_000));
    assert!(resolved.is_ok(), "the ref resolves while the app answers");
    let _stopped = Stopped::new(pid);
    poll("the process to stop", || {
        (process_state(pid) == Some('T')).then_some(())
    });
    let error = rig
        .adapter
        .resolve_window_strict(target, deadline(10_000))
        .expect_err("a stopped process cannot resolve");
    assert_eq!(error.code, ErrorCode::AppUnresponsive);
}

#[test]
#[ignore = "drives real desktop applications; run through scripts/private-session.sh --wm"]
fn signal_live_unscoped_wait_with_an_unrelated_stopped_app_reports_no_events() {
    let mut rig = Rig::new();
    let (stopped_pid, _, _) = calculator(&mut rig);
    let editor = rig.spawn("gnome-text-editor", &["--new-window"]);
    poll("the editor window", || {
        (x11_windows(editor).len() == 1).then_some(())
    });
    identity_of(&rig, editor);
    let seed = capture(&rig, None, None, 10_000).expect("the seed capture");
    let _stopped = Stopped::new(stopped_pid);
    poll("the process to stop", || {
        (process_state(stopped_pid) == Some('T')).then_some(())
    });
    let started = Instant::now();
    let after = capture(&rig, None, None, 10_000).expect("an unscoped capture is not failed");
    assert!(
        started.elapsed() < Duration::from_secs(8),
        "{:?}",
        started.elapsed()
    );
    let events = diff(&seed, &after);
    assert!(
        events.is_empty(),
        "no events expected: {:?}",
        tokens(&events)
    );

    let started = Instant::now();
    let result = wait_event(&rig, "window-closed", None, 4_000, Some(Ok(seed)));
    let elapsed = started.elapsed();
    let error = result.expect_err("nothing closed");
    assert_eq!(error.code(), ErrorCode::Timeout.as_str());
    assert_ne!(
        details_of(&error)["last_error"]["code"],
        "APP_UNRESPONSIVE",
        "{:?}",
        details_of(&error)
    );
    assert!(elapsed < Duration::from_millis(7_000), "{elapsed:?}");
}

#[test]
#[ignore = "drives real desktop applications; run through scripts/private-session.sh --wm"]
fn signal_live_slow_but_alive_target_is_incomplete_and_not_unresponsive() {
    let mut rig = Rig::new();
    let flag = std::env::temp_dir().join(format!("l311d-block-{}", std::process::id()));
    let flag_arg = flag.to_string_lossy().into_owned();
    let pid = launch_qt(&mut rig, &flag_arg);
    poll("the Qt window", || {
        (x11_windows(pid).len() == 1).then_some(())
    });
    let (app, identity) = identity_of(&rig, pid);
    std::fs::write(&flag, "").expect("the block flag");
    std::thread::sleep(Duration::from_millis(800));
    let state = process_state(pid);
    assert!(
        matches!(state, Some('S' | 'R' | 'D')),
        "the target is alive and not stopped: {state:?}"
    );

    let started = Instant::now();
    let seed = capture(&rig, None, Some(&identity), 4_000)
        .expect("a slow but alive target is not an error");
    println!(
        "signal_live slow-alive capture {}ms completeness={:?}",
        started.elapsed().as_millis(),
        seed.completeness
    );
    assert!(
        !seed.completeness.windows && !seed.completeness.apps && !seed.completeness.surfaces,
        "{:?}",
        seed.completeness
    );
    let waited = Instant::now();
    let result = wait_event(&rig, "window-opened", Some(&app), 4_000, Some(Ok(seed)));
    let error = result.expect_err("nothing opens in a blocked app");
    assert_eq!(error.code(), ErrorCode::Timeout.as_str(), "{error}");
    assert_eq!(details_of(&error)["kind"], "wait_timeout");
    assert!(
        waited.elapsed() >= Duration::from_millis(3_500)
            && waited.elapsed() < Duration::from_millis(8_000),
        "the wait kept polling to its deadline: {:?}",
        waited.elapsed()
    );
    assert_ne!(
        details_of(&error)["last_error"]["code"],
        "APP_UNRESPONSIVE",
        "{:?}",
        details_of(&error)
    );
    let _ = std::fs::remove_file(&flag);
}
