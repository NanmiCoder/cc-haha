use std::time::{Duration, Instant};

use agent_desktop_core::{
    Action, Deadline, DeliverySemantics, ErrorCode, NativeHandle, ObservationOps, WindowFilter,
};

use super::live_bench::{Bench, Scripts, Toolkit};
use super::live_bench_iteration::each_scripts;
use super::live_widget_scripts::{
    BROWSER_PAGE, GTK3_WIDGETS, GTK4_WIDGETS, QT_MAIN, QT_PLAIN, QT_WIDGETS,
};
use crate::LinuxAdapter;
use crate::system::window::window_id;
use crate::tree::capabilities::text_selection::{read_caret_and_selection, read_selection};
use crate::tree::live::live_launch::{Launched, nonce};
use crate::tree::vocabulary::role_numbers::{
    CHECK_BOX, CHECK_MENU_ITEM, COMBO_BOX, LIST, PUSH_BUTTON,
};
use crate::tree::vocabulary::state_bits::{CHECKED, SELECTED};

const ALL: [Toolkit; 3] = [Toolkit::Gtk3, Toolkit::Gtk4, Toolkit::Qt];
const BROWSER_SECONDS: u64 = 90;
const LIST_ITEM: u32 = 32;

pub(in crate::actions) fn widgets() -> Scripts<'static> {
    Scripts {
        gtk3: GTK3_WIDGETS,
        gtk4: GTK4_WIDGETS,
        qt: QT_WIDGETS,
    }
}

fn status_becomes(bench: &Bench, wanted: &str) -> bool {
    let status = bench.named("status");
    bench
        .wait_for(|| (bench.text_of(&status) == wanted).then_some(()))
        .is_some()
}

fn checked_becomes(bench: &Bench, handle: &NativeHandle, wanted: bool) -> bool {
    bench
        .wait_for(|| (bench.has_state(handle, CHECKED) == wanted).then_some(()))
        .is_some()
}

fn checked_stays_at(bench: &Bench, handle: &NativeHandle, wanted: bool) -> bool {
    let mut agreeing = 0;
    bench
        .wait_for(|| {
            agreeing = if bench.has_state(handle, CHECKED) == wanted {
                agreeing + 1
            } else {
                0
            };
            (agreeing == 2).then_some(())
        })
        .is_some()
}

#[test]
#[ignore = "drives real desktop applications; run through scripts/private-session.sh --wm"]
fn a_click_runs_the_handler_of_a_button_in_every_toolkit() {
    each_scripts(&widgets(), &ALL, |toolkit, bench| {
        let button = bench
            .find(PUSH_BUTTON, "Press me")
            .unwrap_or_else(|| panic!("{toolkit:?}: no button"));
        bench
            .act(&button, Action::Click)
            .unwrap_or_else(|error| panic!("{toolkit:?}: {error}"));
        assert!(status_becomes(bench, "clicked"), "{toolkit:?}");
    });
}

#[test]
#[ignore = "drives real desktop applications; run through scripts/private-session.sh --wm"]
fn toggle_check_and_uncheck_move_a_check_box_and_never_write_twice() {
    each_scripts(&widgets(), &ALL, |toolkit, bench| {
        let flag = bench
            .find(CHECK_BOX, "Flag")
            .unwrap_or_else(|| panic!("{toolkit:?}: no check box"));
        assert!(!bench.has_state(&flag, CHECKED), "{toolkit:?}");
        if matches!(toolkit, Toolkit::Gtk4) {
            assert!(bench.action_names(&flag).is_empty(), "{toolkit:?}");
            let refused = bench
                .act(&flag, Action::Toggle)
                .expect_err("a GTK4 check button advertises no action");
            assert_eq!(refused.code, ErrorCode::ActionNotSupported, "{toolkit:?}");
            let details = refused.details.expect("details");
            assert_eq!(details["semantic_verb"], "absent", "{toolkit:?}");
            let click = bench
                .act(&flag, Action::Click)
                .expect_err("a headless click on a node with no verb needs the pointer");
            assert_eq!(click.code, ErrorCode::PolicyDenied, "{toolkit:?}");
            assert_eq!(
                click.disposition,
                DeliverySemantics::not_delivered(),
                "{toolkit:?}"
            );
            assert!(!bench.has_state(&flag, CHECKED), "{toolkit:?}");
            return;
        }
        bench
            .act(&flag, Action::Toggle)
            .unwrap_or_else(|error| panic!("{toolkit:?}: {error}"));
        assert!(checked_becomes(bench, &flag, true), "{toolkit:?}: toggle");
        let again = bench
            .act(&flag, Action::Check)
            .unwrap_or_else(|error| panic!("{toolkit:?}: {error}"));
        assert_eq!(
            again.disposition(),
            DeliverySemantics::not_delivered(),
            "{toolkit:?}: check twice writes nothing"
        );
        assert!(
            checked_stays_at(bench, &flag, true),
            "{toolkit:?}: check twice"
        );
        bench
            .act(&flag, Action::Uncheck)
            .unwrap_or_else(|error| panic!("{toolkit:?}: {error}"));
        assert!(checked_becomes(bench, &flag, false), "{toolkit:?}: uncheck");
    });
}

#[test]
#[ignore = "drives real desktop applications; run through scripts/private-session.sh --wm"]
fn select_by_display_value_chooses_the_item_of_a_combo_box() {
    each_scripts(
        &widgets(),
        &[Toolkit::Gtk3, Toolkit::Qt],
        |toolkit, bench| {
            let combo = bench
                .with_role(COMBO_BOX)
                .unwrap_or_else(|| panic!("{toolkit:?}: no combo box"));
            let result = bench.act(&combo, Action::Select("beta".to_owned()));
            if matches!(toolkit, Toolkit::Qt) {
                let refused = result.expect_err("a Qt combo popup takes no semantic selection");
                assert_eq!(refused.code, ErrorCode::PolicyDenied, "{toolkit:?}");
                assert_eq!(
                    refused.details.expect("details")["kind"],
                    "pointer_required"
                );
                assert_eq!(bench.name_of(&combo), "alpha", "{toolkit:?}");
                return;
            }
            result.unwrap_or_else(|error| panic!("{toolkit:?}: {error}"));
            assert!(status_becomes(bench, "combo:beta"), "{toolkit:?}");
            let renamed = bench
                .wait_for(|| (bench.name_of(&combo) == "beta").then_some(()))
                .is_some();
            assert!(
                renamed,
                "{toolkit:?}: the combo reads {}",
                bench.name_of(&combo)
            );
        },
    );
}

#[test]
#[ignore = "drives real desktop applications; run through scripts/private-session.sh --wm"]
fn select_by_display_value_chooses_the_item_of_a_qt_list() {
    each_scripts(&widgets(), &[Toolkit::Qt], |toolkit, bench| {
        let list = bench
            .find(LIST, "items")
            .unwrap_or_else(|| panic!("{toolkit:?}: no list"));
        bench
            .act(&list, Action::Select("two".to_owned()))
            .unwrap_or_else(|error| panic!("{toolkit:?}: {error}"));
        assert!(status_becomes(bench, "list:two"), "{toolkit:?}");
        let item = bench.find(LIST_ITEM, "two").expect("the item");
        assert!(bench.has_state(&item, SELECTED), "{toolkit:?}");
    });
}

#[test]
#[ignore = "drives real desktop applications; run through scripts/private-session.sh --wm"]
fn the_selection_reads_in_utf16_and_the_caret_in_code_points() {
    each_scripts(
        &widgets(),
        &[Toolkit::Gtk3, Toolkit::Gtk4],
        |toolkit, bench| {
            let name = if matches!(toolkit, Toolkit::Gtk3) {
                "view"
            } else {
                "field"
            };
            let text = bench.named(name);
            assert!(bench.add_selection(&text, 2, 7), "{toolkit:?}: select");
            let budget = || Deadline::after(5_000).expect("a deadline");
            let utf16 = read_selection(bench.adapter().bus(), &text, budget())
                .unwrap_or_else(|error| panic!("{toolkit:?}: {error}"));
            assert_eq!(utf16, Some(3..8), "{toolkit:?}");
            let element = crate::tree::atspi_element(&text).expect("an element");
            let (caret, selections) =
                read_caret_and_selection(bench.adapter().bus(), element, budget())
                    .unwrap_or_else(|error| panic!("{toolkit:?}: {error}"))
                    .expect("the caret and the selection read");
            assert_eq!(selections, vec![2..7], "{toolkit:?}");
            assert!(caret == 2 || caret == 7, "{toolkit:?}: caret {caret}");
        },
    );
}

fn frame_of_app(adapter: &LinuxAdapter, app: &str) -> crate::tree::AtspiElement {
    let started = Instant::now();
    loop {
        let filter = WindowFilter {
            focused_only: false,
            app: Some(app.to_owned()),
        };
        let windows = adapter
            .list_windows(&filter, Deadline::after(5_000).expect("a deadline"))
            .unwrap_or_default();
        if let Some(window) = windows.first() {
            let (bus, path) = window_id::decode(&window.id).expect("a window id");
            return crate::tree::AtspiElement::new(bus, path, window.pid.get());
        }
        assert!(
            started.elapsed() < Duration::from_secs(40),
            "no {app} window"
        );
        std::thread::sleep(Duration::from_millis(300));
    }
}

#[test]
#[ignore = "drives a real desktop application; run through scripts/private-session.sh --wm"]
fn the_read_only_menu_item_of_gnome_terminal_toggles() {
    let adapter = LinuxAdapter::new();
    let mut launched = Launched::new();
    launched.spawn(
        "gnome-terminal",
        &["--wait", "--", "bash", "-c", "sleep 300"],
    );
    let frame = frame_of_app(&adapter, "gnome-terminal-server");
    let bench = Bench::attach(launched, frame);
    let item = bench
        .find(CHECK_MENU_ITEM, "Read-Only")
        .expect("the Read-Only menu item");
    assert!(!bench.has_state(&item, CHECKED));
    bench
        .act(&item, Action::Toggle)
        .unwrap_or_else(|error| panic!("{error}"));
    assert!(checked_becomes(&bench, &item, true), "toggled on");
    bench
        .act(&item, Action::Toggle)
        .unwrap_or_else(|error| panic!("{error}"));
    assert!(checked_becomes(&bench, &item, false), "toggled off");
}

fn browser_bench(
    program: &str,
    environment: &[(&'static str, String)],
    arguments: impl Fn(&str, &str) -> Vec<String>,
) -> (Bench, String) {
    let tag = nonce("page");
    let dir = std::env::temp_dir().join(&tag);
    std::fs::create_dir_all(&dir).expect("a page directory");
    let page = dir.join("page.html");
    std::fs::write(&page, BROWSER_PAGE.replace("TAG", &tag)).expect("a page");
    let mut launched = Launched::new();
    launched.scratch.push(dir.clone());
    let url = format!("file://{}", page.display());
    let profile = dir.join("profile").to_string_lossy().into_owned();
    let owned = arguments(&url, &profile);
    let borrowed: Vec<&str> = owned.iter().map(String::as_str).collect();
    let pid = launched.spawn_with_env(program, &borrowed, environment);
    let adapter = LinuxAdapter::new();
    let frame = Bench::wait_for_frame(&adapter, &tag, pid, BROWSER_SECONDS)
        .unwrap_or_else(|reason| panic!("{program}: {reason}"));
    (Bench::attach(launched, frame), tag)
}

fn drive_page(bench: &Bench, tag: &str, label: &str) {
    let frame = bench.frame().clone().into_native_handle();
    let titled = |wanted: String| {
        bench
            .wait_for(|| bench.name_of(&frame).contains(&wanted).then_some(()))
            .is_some()
    };
    let button = bench
        .find(PUSH_BUTTON, "Press")
        .unwrap_or_else(|| panic!("{label}: no button"));
    bench
        .act(&button, Action::Click)
        .unwrap_or_else(|error| panic!("{label}: {error}"));
    assert!(titled(format!("{tag}:clicked")), "{label}: click");
    let agree = bench
        .find(CHECK_BOX, "Agree")
        .unwrap_or_else(|| panic!("{label}: no check box"));
    bench
        .act(&agree, Action::Check)
        .unwrap_or_else(|error| panic!("{label}: {error}"));
    assert!(titled(format!("{tag}:chk=true")), "{label}: check title");
    assert!(checked_becomes(bench, &agree, true), "{label}: check state");
    bench
        .act(&agree, Action::Uncheck)
        .unwrap_or_else(|error| panic!("{label}: {error}"));
    assert!(titled(format!("{tag}:chk=false")), "{label}: uncheck title");
}

#[test]
#[ignore = "drives a real desktop application; run through scripts/private-session.sh --wm"]
fn a_gecko_page_takes_a_click_and_a_check() {
    let snap = "/snap/firefox/current";
    let library_path = format!(
        "{snap}/usr/lib/firefox:{snap}/usr/lib/x86_64-linux-gnu:{snap}/gnome-platform/usr/lib/x86_64-linux-gnu"
    );
    let (bench, tag) = browser_bench(
        "/snap/firefox/current/usr/lib/firefox/firefox",
        &[
            ("LD_LIBRARY_PATH", library_path),
            ("GTK_A11Y", "atspi".to_owned()),
            ("MOZ_ENABLE_WAYLAND", "0".to_owned()),
        ],
        |url, profile| {
            std::fs::create_dir_all(profile).expect("a profile directory");
            vec![
                "--no-remote".to_owned(),
                "--profile".to_owned(),
                profile.to_owned(),
                "--new-window".to_owned(),
                url.to_owned(),
            ]
        },
    );
    drive_page(&bench, &tag, "gecko");
}

#[test]
#[ignore = "drives real desktop applications; run through scripts/private-session.sh --wm"]
fn a_plain_qwidget_and_a_qmainwindow_are_both_listed_windows() {
    let (python, environment) = super::live_bench_env::qt_environment();
    let tag = nonce("qtlist");
    let dir = std::env::temp_dir().join(&tag);
    std::fs::create_dir_all(&dir).expect("a directory");
    let mut launched = Launched::new();
    launched.scratch.push(dir.clone());
    for (name, source) in [("plain", QT_PLAIN), ("main", QT_MAIN)] {
        let script = dir.join(format!("{name}.py"));
        std::fs::write(&script, source).expect("a script");
        launched.spawn_with_env(&python, &[&script.to_string_lossy(), &tag], &environment);
    }
    let adapter = LinuxAdapter::new();
    let listed = wait_for_titles(&adapter, &[&format!("plain-{tag}"), &format!("main-{tag}")]);
    launched.stop();
    assert!(listed.is_ok(), "{listed:?}");
}

fn wait_for_titles(adapter: &LinuxAdapter, wanted: &[&str]) -> Result<(), String> {
    let started = Instant::now();
    let mut seen = Vec::new();
    while started.elapsed() < Duration::from_secs(30) {
        let windows = adapter
            .list_windows(
                &WindowFilter::default(),
                Deadline::after(5_000).expect("a deadline"),
            )
            .unwrap_or_default();
        seen = windows.iter().map(|window| window.title.clone()).collect();
        if wanted
            .iter()
            .all(|title| seen.iter().any(|shown| shown.contains(title)))
        {
            return Ok(());
        }
        std::thread::sleep(Duration::from_millis(300));
    }
    Err(format!("listed windows: {seen:?}"))
}
