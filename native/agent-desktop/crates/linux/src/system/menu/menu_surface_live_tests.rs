use std::time::{Duration, Instant};

use agent_desktop_core::{WindowFilter, WindowInfo};

use super::menu_live_rig::{Rig, deadline, is_closed_ref, poll, press_escape, right_click, tool};
use crate::system::list_windows;
use crate::tree::live::live_launch::{Launched, nonce};

const GTK3_SCRIPT: &str = r#"
import gi, os, sys
gi.require_version("Gtk", "3.0")
from gi.repository import Gtk
log = os.environ["AD_LIVE_LOG"]
def mark(*_):
    open(log, "a").write("picked\n")
w = Gtk.Window(title="adm3-" + sys.argv[1])
w.set_default_size(420, 260)
box = Gtk.Box(orientation=Gtk.Orientation.VERTICAL)
bar = Gtk.MenuBar()
file_item = Gtk.MenuItem(label="File")
file_menu = Gtk.Menu()
for label in ("Open", "Save"):
    entry_item = Gtk.MenuItem(label=label)
    entry_item.connect("activate", mark)
    file_menu.append(entry_item)
file_item.set_submenu(file_menu)
bar.append(file_item)
box.pack_start(bar, False, False, 0)
entry = Gtk.Entry()
entry.set_text("hello")
def populate(widget, menu):
    extra = Gtk.MenuItem(label="Log pick")
    extra.connect("activate", mark)
    extra.show()
    menu.append(extra)
entry.connect("populate-popup", populate)
box.pack_start(entry, True, True, 0)
w.add(box)
w.connect("destroy", Gtk.main_quit)
w.show_all()
Gtk.main()
"#;

const QT_SCRIPT: &str = r#"
import os, sys
from PyQt6.QtWidgets import QApplication, QMainWindow, QLineEdit
app = QApplication(sys.argv)
w = QMainWindow()
w.setWindowTitle("adqm-" + sys.argv[1])
log = os.environ["AD_LIVE_LOG"]
m = w.menuBar().addMenu("File")
m.addAction("Open", lambda: open(log, "a").write("picked\n"))
m.addAction("Save")
w.setCentralWidget(QLineEdit())
w.resize(420, 260)
w.show()
sys.exit(app.exec())
"#;

fn script_log(source: &str) -> (String, String) {
    let dir = std::env::var("AGENT_DESKTOP_PRIVATE_SESSION").expect("a private session");
    let tag = nonce("menu");
    let script = format!("{dir}/{tag}.py");
    std::fs::write(&script, source).expect("a script");
    (script, format!("{dir}/{tag}.log"))
}

fn logged(log: &str) -> bool {
    std::fs::read_to_string(log).is_ok_and(|text| text.contains("picked"))
}

fn centre_of(title_part: &str) -> (i32, i32) {
    poll("the window geometry", || {
        let listing = tool("wmctrl", &["-lG"]);
        let line = listing.lines().find(|line| line.contains(title_part))?;
        let numbers: Vec<i32> = line
            .split_whitespace()
            .skip(2)
            .take(4)
            .filter_map(|word| word.parse().ok())
            .collect();
        let [x, y, w, h] = numbers.as_slice() else {
            return None;
        };
        Some((x + w / 2, y + h * 3 / 4))
    })
}

fn windows_named(rig: &Rig) -> Vec<WindowInfo> {
    let filter = WindowFilter {
        focused_only: false,
        app: None,
    };
    list_windows(&rig.bus, &filter, deadline())
        .unwrap_or_default()
        .into_iter()
        .filter(|window| window.pid == rig.pid)
        .collect()
}

struct Case<'a> {
    window: &'a WindowInfo,
    open: &'a dyn Fn(&Rig),
    pick: &'a str,
    effect: &'a dyn Fn(&Rig) -> bool,
    close: &'a dyn Fn(&Rig),
}

fn exercise(rig: &Rig, case: &Case<'_>) {
    (case.open)(rig);
    let surface = poll("a menu surface", || rig.menu_surface());
    assert_eq!(
        surface.id, case.window.id,
        "the menu lists on the owner window"
    );
    let listed = surface.item_count.expect("an item count");
    assert!(listed > 0, "the menu surface counts items");
    assert_eq!(
        rig.open_item_count(),
        listed,
        "an independent read of the open menu counts the same items"
    );
    let entries = rig.menu_entries(case.window).expect("the menu snapshot");
    let named: Vec<String> = entries
        .iter()
        .filter_map(|(_, entry)| entry.identity.name.clone())
        .collect();
    println!("menu_live items={named:?} listed={listed}");
    assert!(!named.is_empty(), "the menu items carry names");
    let (_, entry) = entries
        .iter()
        .find(|(_, entry)| {
            entry
                .identity
                .name
                .as_deref()
                .is_some_and(|name| name.starts_with(case.pick))
        })
        .unwrap_or_else(|| panic!("no item {:?} among {named:?}", case.pick));
    let target = rig
        .resolve(entry)
        .expect("a menu ref resolves while it is open");
    rig.do_action(&target);
    poll("the effect of the click", || {
        (case.effect)(rig).then_some(())
    });
    let started = Instant::now();
    while rig.menu_surface().is_some() && started.elapsed() < Duration::from_secs(3) {
        std::thread::sleep(Duration::from_millis(100));
    }
    if rig.menu_surface().is_some() {
        (case.close)(rig);
    }
    poll("the menu to close", || {
        rig.menu_surface().is_none().then_some(())
    });
    let error = rig
        .resolve(entry)
        .expect_err("a closed menu's ref is stale");
    assert!(
        is_closed_ref(&error),
        "stale because the menu closed: {error:?}"
    );
    let error = rig
        .menu_entries(case.window)
        .expect_err("a closed menu has no snapshot");
    assert!(error.contains("open menu"), "{error}");
}

#[test]
#[ignore = "drives real desktop applications; run through scripts/private-session.sh --wm"]
fn menu_live_gtk4_main_menu_lists_snapshots_and_goes_stale() {
    let mut launched = Launched::new();
    let pid = launched.spawn("gnome-calculator", &[]);
    let rig = Rig::attach(pid);
    let window = rig.window();
    let opener = poll("the Main Menu toggle", || {
        rig.window_entry(&window, "switch", "Main Menu")
    });
    let toggle = rig.resolve(&opener).expect("the toggle resolves");
    exercise(
        &rig,
        &Case {
            window: &window,
            open: &|rig| rig.do_action(&toggle),
            pick: "About",
            effect: &|rig| {
                rig.surfaces().iter().any(|s| s.kind == "sheet") || windows_named(rig).len() > 1
            },
            close: &|_| press_escape(),
        },
    );
}

#[test]
#[ignore = "drives real desktop applications; run through scripts/private-session.sh --wm"]
fn menu_live_gtk4_text_editor_context_menu() {
    let mut launched = Launched::new();
    let dir = std::env::var("AGENT_DESKTOP_PRIVATE_SESSION").expect("a private session");
    let file = format!("{dir}/{}.txt", nonce("note"));
    std::fs::write(&file, "alpha beta gamma\n").expect("a note");
    let pid = launched.spawn("gnome-text-editor", &[&file]);
    let rig = Rig::attach(pid);
    let window = rig.window();
    let (x, y) = centre_of(&window.title);
    exercise(
        &rig,
        &Case {
            window: &window,
            open: &|_| right_click(x, y),
            pick: "Select All",
            effect: &|rig| rig.text_selection_count() > 0,
            close: &|_| press_escape(),
        },
    );
}

#[test]
#[ignore = "drives real desktop applications; run through scripts/private-session.sh --wm"]
fn menu_live_gtk3_context_menu_is_a_top_level_popup() {
    let mut launched = Launched::new();
    let (script, log) = script_log(GTK3_SCRIPT);
    let tag = nonce("g3");
    let pid = launched.spawn_with_env("python3", &[&script, &tag], &[("AD_LIVE_LOG", log.clone())]);
    let rig = Rig::attach(pid);
    let window = rig.window();
    let entry = poll("the entry", || rig.raw_find(&[61, 79], ""));
    let reply = rig
        .connection
        .call_method(
            Some(entry.bus_name()),
            entry.path(),
            Some("org.a11y.atspi.Component"),
            "GetExtents",
            &(0_u32,),
        )
        .expect("the entry screen bounds");
    let (x, y, width, height): (i32, i32, i32, i32) = reply.body().deserialize().unwrap();
    let (x, y) = (x + width / 2, y + height / 2);
    exercise(
        &rig,
        &Case {
            window: &window,
            open: &|_| right_click(x, y),
            pick: "Log pick",
            effect: &|_| logged(&log),
            close: &|_| press_escape(),
        },
    );
}

#[test]
#[ignore = "drives real desktop applications; run through scripts/private-session.sh --wm"]
fn menu_live_gtk3_menu_bar_flips_state_inside_the_frame() {
    let mut launched = Launched::new();
    let (script, log) = script_log(GTK3_SCRIPT);
    let tag = nonce("g3b");
    let pid = launched.spawn_with_env("python3", &[&script, &tag], &[("AD_LIVE_LOG", log.clone())]);
    let rig = Rig::attach(pid);
    let window = rig.window();
    let file = poll("the File menu", || rig.raw_find(&[33], "File"));
    assert!(
        rig.menu_surface().is_none(),
        "an idle menu bar is not an open menu"
    );
    exercise(
        &rig,
        &Case {
            window: &window,
            open: &|rig| rig.do_action(&file),
            pick: "Open",
            effect: &|_| logged(&log),
            close: &|rig| rig.do_action(&file),
        },
    );
}

#[test]
#[ignore = "drives real desktop applications; run through scripts/private-session.sh --wm"]
fn menu_live_qt_menu_bar_popup_is_a_child_of_its_item() {
    let mut launched = Launched::new();
    let (script, log) = script_log(QT_SCRIPT);

    let python = std::env::var("AGENT_DESKTOP_QT_PYTHON").unwrap_or_else(|_| "python3".to_owned());

    let pid = launched.spawn_with_env(
        &python,
        &[&script, &nonce("q")],
        &[
            ("AD_LIVE_LOG", log.clone()),
            ("QT_ACCESSIBILITY", "1".to_owned()),
            ("QT_LINUX_ACCESSIBILITY_ALWAYS_ON", "1".to_owned()),
            ("QT_QPA_PLATFORM", "xcb".to_owned()),
        ],
    );
    let rig = Rig::attach(pid);
    let window = rig.window();
    let file = poll("the File item", || rig.raw_find(&[35], "File"));
    assert!(
        rig.menu_surface().is_none(),
        "idle bar items that show are not an open menu"
    );
    exercise(
        &rig,
        &Case {
            window: &window,
            open: &|rig| rig.do_action(&file),
            pick: "Open",
            effect: &|_| logged(&log),
            close: &|rig| rig.do_action(&file),
        },
    );
}

#[test]
#[ignore = "drives real desktop applications; run through scripts/private-session.sh --wm"]
fn menu_live_chromium_page_menu_is_a_new_top_level_frame() {
    let mut launched = Launched::new();
    let dir = std::env::var("AGENT_DESKTOP_PRIVATE_SESSION").expect("a private session");
    let profile = format!("{dir}/{}", nonce("chrome"));
    let pid = launched.spawn(
        "google-chrome",
        &[
            "--password-store=basic",
            "--no-first-run",
            "--force-renderer-accessibility",
            &format!("--user-data-dir={profile}"),
            "data:text/html,<title>menuprobe</title><script>document.title='menuprobe-'+performance.timeOrigin</script><h1>menu probe</h1>",
        ],
    );
    let rig = Rig::attach(pid);
    let window = poll("the browser window", || {
        let window = rig.window();
        window.title.contains("menuprobe").then_some(window)
    });
    let (x, y) = centre_of("menuprobe");
    exercise(
        &rig,
        &Case {
            window: &window,
            open: &|rig| {
                for _ in 0..8 {
                    right_click(x, y);
                    let started = Instant::now();
                    while started.elapsed() < Duration::from_secs(3) {
                        if rig.menu_surface().is_some() {
                            return;
                        }
                        std::thread::sleep(Duration::from_millis(150));
                    }
                    press_escape();
                }
            },
            pick: "Reload",
            effect: &|_| {
                tool("wmctrl", &["-l"])
                    .lines()
                    .any(|line| line.contains("menuprobe-") && !line.contains(&window.title))
            },
            close: &|_| press_escape(),
        },
    );
}
