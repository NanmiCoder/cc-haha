use std::time::{Duration, Instant};

use agent_desktop_core::ErrorCode;

use crate::system::signal::signal_live_apps::{
    MENU, MENU_ITEM, Node, POPUP_MENU, Rig, STATE_CHECKED, STATE_SHOWING, Stopped, TOGGLE,
    close_with_escape, descendants, details_of, do_action, identity_of, launch_qt,
    main_menu_toggle, outcome, poll, process_state, scratch_dir, showing_of, signal,
    terminal_server, wait_menu, x11_windows,
};

const MENU_MS: u64 = 15_000;
const CHECK_MENU_ITEM: u32 = 8;

fn elapsed_ms(result: &Result<serde_json::Value, agent_desktop_core::AppError>) -> u64 {
    found(result)["elapsed_ms"].as_u64().unwrap_or(u64::MAX)
}

fn found(result: &Result<serde_json::Value, agent_desktop_core::AppError>) -> &serde_json::Value {
    match result {
        Ok(value) => {
            assert_eq!(value["found"], true, "{}", outcome(result));
            value
        }
        Err(error) => panic!("the menu wait failed: {}", error.code()),
    }
}

fn flips(
    rig: &Rig,
    app: &str,
    open: bool,
    action: impl FnOnce(),
    oracle: impl Fn() -> bool + Sync,
) {
    let (result, finished, acted) = std::thread::scope(|scope| {
        let waiter = scope.spawn(|| (wait_menu(rig, app, open, 20_000), Instant::now()));
        std::thread::sleep(Duration::from_millis(1_000));
        assert!(
            !waiter.is_finished(),
            "the wait for open={open} must still be pending before the menu changes"
        );
        let acted = Instant::now();
        action();
        poll("the independent oracle to agree", || {
            (oracle() == open).then_some(())
        });
        let (result, finished) = waiter.join().expect("the waiter finished");
        (result, finished, acted)
    });
    found(&result);
    assert!(
        finished >= acted,
        "the wait ended before the action that changes the menu"
    );
}

struct Legs<'a> {
    label: &'a str,
    app: &'a str,
    open: &'a (dyn Fn() + Sync),
    close: &'a (dyn Fn() + Sync),
    is_open: &'a (dyn Fn() -> bool + Sync),
}

fn both_directions(rig: &Rig, legs: &Legs) {
    assert!(!(legs.is_open)(), "{}: the menu starts closed", legs.label);
    let closed = wait_menu(rig, legs.app, false, MENU_MS);
    assert!(
        elapsed_ms(&closed) < 1_500,
        "{}: a closed menu satisfies --menu-closed at once: {}",
        legs.label,
        outcome(&closed)
    );
    flips(rig, legs.app, true, || (legs.open)(), || (legs.is_open)());
    let already = wait_menu(rig, legs.app, true, MENU_MS);
    assert!(
        elapsed_ms(&already) < 1_500,
        "{}: an open menu satisfies --menu at once: {}",
        legs.label,
        outcome(&already)
    );
    flips(rig, legs.app, false, || (legs.close)(), || (legs.is_open)());
}

fn gtk4_menu(rig: &mut Rig, program: &str, args: &[&str]) {
    let pid = rig.spawn(program, args);
    poll("the window", || {
        (!x11_windows(pid).is_empty()).then_some(())
    });
    let (app, _) = identity_of(rig, pid);
    let node = main_menu_toggle(rig, pid);
    let idle = showing_of(&rig.connection, pid, &[MENU]);
    let toggle = || do_action(&rig.connection, &node);
    let legs = Legs {
        label: program,
        app: &app,
        open: &toggle,
        close: &toggle,
        is_open: &|| showing_of(&rig.connection, pid, &[MENU]) > idle,
    };
    both_directions(rig, &legs);
}

#[test]
#[ignore = "drives real desktop applications; run through scripts/private-session.sh --wm"]
fn menu_wait_live_files_main_menu_both_directions() {
    let mut rig = Rig::new();
    let folder = scratch_dir(&mut rig, "l311d-files");
    gtk4_menu(&mut rig, "nautilus", &["--new-window", &folder]);
}

fn named(rig: &Rig, pid: u32, role: u32, name: &str) -> Node {
    poll(name, || {
        descendants(&rig.connection, pid)
            .into_iter()
            .find(|n| n.role == role && n.name == name)
    })
}

fn show_terminal_menu_bar(rig: &Rig, pid: u32) {
    do_action(&rig.connection, &named(rig, pid, MENU, "View"));
    let item = poll("Show Menubar", || {
        descendants(&rig.connection, pid).into_iter().find(|n| {
            (n.role == MENU_ITEM || n.role == CHECK_MENU_ITEM) && n.name.contains("Menubar")
        })
    });
    do_action(&rig.connection, &item);
    poll("the menu bar to show", || {
        named_showing(rig, pid, "Edit").then_some(())
    });
}

fn named_showing(rig: &Rig, pid: u32, name: &str) -> bool {
    descendants(&rig.connection, pid)
        .iter()
        .any(|n| n.role == MENU && n.name == name && n.has(STATE_SHOWING))
}

#[test]
#[ignore = "drives real desktop applications; run through scripts/private-session.sh --wm"]
fn menu_wait_live_terminal_bar_menu_opens_and_closes_by_escape() {
    let mut rig = Rig::new();
    let pid = terminal_server(&mut rig);
    let (app, _) = identity_of(&rig, pid);
    show_terminal_menu_bar(&rig, pid);
    let idle = showing_of(&rig.connection, pid, &[MENU_ITEM]);
    let open = || do_action(&rig.connection, &named(&rig, pid, MENU, "Edit"));
    let close = || {
        close_with_escape(&rig, &app, || {
            showing_of(&rig.connection, pid, &[MENU_ITEM]) <= idle
        })
    };
    let legs = Legs {
        label: "terminal-bar",
        app: &app,
        open: &open,
        close: &close,
        is_open: &|| showing_of(&rig.connection, pid, &[MENU_ITEM]) > idle,
    };
    both_directions(&rig, &legs);
}

#[test]
#[ignore = "drives real desktop applications; run through scripts/private-session.sh --wm"]
fn menu_wait_live_terminal_header_popover_opens_and_closes_by_click() {
    let mut rig = Rig::new();
    let pid = terminal_server(&mut rig);
    let (app, _) = identity_of(&rig, pid);
    let toggle = || do_action(&rig.connection, &named(&rig, pid, TOGGLE, "Menu"));
    let legs = Legs {
        label: "terminal-popover",
        app: &app,
        open: &toggle,
        close: &toggle,
        is_open: &|| named(&rig, pid, TOGGLE, "Menu").has(STATE_CHECKED),
    };
    both_directions(&rig, &legs);
}

#[test]
#[ignore = "drives real desktop applications; run through scripts/private-session.sh --wm"]
fn menu_wait_live_terminal_hidden_bar_times_out_with_the_direction_message() {
    let mut rig = Rig::new();
    let pid = terminal_server(&mut rig);
    let (app, _) = identity_of(&rig, pid);
    do_action(&rig.connection, &named(&rig, pid, MENU, "Edit"));
    let started = Instant::now();
    let error = wait_menu(&rig, &app, true, 3_000).expect_err("a hidden bar is no open menu");
    assert_eq!(error.code(), ErrorCode::Timeout.as_str(), "{error}");
    assert!(started.elapsed() < Duration::from_millis(6_000));
    let detail = match &error {
        agent_desktop_core::AppError::Adapter(adapter) => {
            adapter.platform_detail.clone().unwrap_or_default()
        }
        _ => String::new(),
    };
    let message = format!("{error} {detail}").to_lowercase();
    println!("menu_wait_live hidden bar message={message:?}");
    assert!(message.contains("menu"), "{message}");
    assert!(
        message.contains("open") || message.contains("--menu"),
        "the message names the direction: {message}"
    );
}

#[test]
#[ignore = "drives real desktop applications; run through scripts/private-session.sh --wm"]
fn menu_wait_live_qt_file_menu_both_directions() {
    let mut rig = Rig::new();
    let flag = std::env::temp_dir().join(format!("l311d-never-{}", std::process::id()));
    let pid = launch_qt(&mut rig, &flag.to_string_lossy());
    poll("the Qt window", || {
        (x11_windows(pid).len() == 1).then_some(())
    });
    let (app, _) = identity_of(&rig, pid);
    let idle = showing_of(&rig.connection, pid, &[POPUP_MENU]);
    let toggle = || do_action(&rig.connection, &named(&rig, pid, MENU_ITEM, "File"));
    let legs = Legs {
        label: "qt-file",
        app: &app,
        open: &toggle,
        close: &toggle,
        is_open: &|| showing_of(&rig.connection, pid, &[POPUP_MENU]) > idle,
    };
    both_directions(&rig, &legs);
}

#[test]
#[ignore = "drives real desktop applications; run through scripts/private-session.sh --wm"]
fn menu_wait_live_target_exiting_mid_wait_is_stale_ref() {
    let mut rig = Rig::new();
    let pid = rig.spawn("gnome-calculator", &[]);
    poll("the calculator window", || {
        (x11_windows(pid).len() == 1).then_some(())
    });
    let (app, identity) = identity_of(&rig, pid);
    let result = std::thread::scope(|scope| {
        let waiter = scope.spawn(|| wait_menu(&rig, &app, true, 20_000));
        std::thread::sleep(Duration::from_millis(1_500));
        signal("-KILL", pid);
        waiter.join().expect("the waiter finished")
    });
    let error = result.expect_err("a dead target never satisfies --menu");
    let details = details_of(&error).to_string();
    println!(
        "menu_wait_live exit mid-wait: {} details={details}",
        error.code()
    );
    assert_eq!(error.code(), ErrorCode::StaleRef.as_str(), "{error}");
    assert!(
        details.contains(&pid.to_string()),
        "pid in details: {details}"
    );
    assert!(
        details.contains(&identity.instance),
        "instance in details: {details}"
    );
}

#[test]
#[ignore = "drives real desktop applications; run through scripts/private-session.sh --wm"]
fn menu_wait_live_stopped_target_is_app_unresponsive_without_the_full_wait() {
    let mut rig = Rig::new();
    let pid = rig.spawn("gnome-calculator", &[]);
    poll("the calculator window", || {
        (x11_windows(pid).len() == 1).then_some(())
    });
    let (app, _) = identity_of(&rig, pid);
    let _stopped = Stopped::new(pid);
    poll("the process to stop", || {
        (process_state(pid) == Some('T')).then_some(())
    });
    let started = Instant::now();
    let result = wait_menu(&rig, &app, true, 25_000);
    let elapsed = started.elapsed();
    let error = result.expect_err("a stopped target never opens a menu");
    assert_eq!(error.code(), ErrorCode::AppUnresponsive.as_str(), "{error}");
    assert!(elapsed < Duration::from_secs(10), "{elapsed:?}");
}
