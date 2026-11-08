use super::live_bench::{Bench, Scripts, Toolkit};
use super::live_click_tests::{act, find, open, state};
use crate::actions::disclosure::set_expanded;
use crate::tree::live::live_launch::nonce;
use crate::tree::vocabulary::role_numbers::PUSH_BUTTON;
use crate::tree::vocabulary::state_bits::{EXPANDABLE, EXPANDED};
use agent_desktop_core::{Action, DeliveryDisposition};
use std::path::PathBuf;
use std::process::Command;
use std::time::{Duration, Instant};

struct Fixture {
    directory: PathBuf,
    settings: Vec<(&'static str, &'static str, String)>,
}

fn setting(operation: &str, schema: &str, key: &str, value: Option<&str>) -> String {
    let output = Command::new("gsettings")
        .args([operation, schema, key])
        .args(value)
        .output()
        .expect("gsettings runs");
    assert!(output.status.success(), "gsettings: {:?}", output.stderr);
    String::from_utf8(output.stdout).unwrap().trim().to_owned()
}

impl Fixture {
    fn new() -> Self {
        assert!(std::env::var_os("AGENT_DESKTOP_PRIVATE_SESSION").is_some());
        let mut fixture = Self {
            directory: std::env::temp_dir().join(nonce("disclosure")),
            settings: Vec::new(),
        };
        for (schema, key, value) in [
            ("org.gnome.nautilus.list-view", "use-tree-view", "true"),
            (
                "org.gnome.nautilus.preferences",
                "default-folder-viewer",
                "'list-view'",
            ),
        ] {
            fixture
                .settings
                .push((schema, key, setting("get", schema, key, None)));
            setting("set", schema, key, Some(value));
        }
        std::fs::create_dir_all(fixture.directory.join("folder")).unwrap();
        std::fs::write(fixture.directory.join("folder/leaf.txt"), "tree leaf").unwrap();
        fixture
    }
}

impl Drop for Fixture {
    fn drop(&mut self) {
        for (schema, key, value) in &self.settings {
            setting("set", schema, key, Some(value));
        }
        std::fs::remove_dir_all(&self.directory).expect("fixture removed");
    }
}

fn oracle(expected: (bool, bool)) {
    let started = Instant::now();
    loop {
        let output = Command::new("python3")
            .args([
                "-c",
                r#"
import gi, json
gi.require_version('Atspi', '2.0')
from gi.repository import Atspi
pending = [(Atspi.get_desktop(0), False)]
rows, leaves = [], []
while pending:
    node, in_folder = pending.pop()
    in_folder = in_folder or (node.get_role() == Atspi.Role.TABLE_ROW and node.get_name() == 'folder')
    states = node.get_state_set()
    if in_folder and states.contains(Atspi.StateType.EXPANDABLE):
        rows.append(states.contains(Atspi.StateType.EXPANDED))
    if node.get_name() == 'leaf.txt' and states.contains(Atspi.StateType.SHOWING):
        leaves.append(node)
    pending.extend((node.get_child_at_index(i), in_folder) for i in range(node.get_child_count()))
assert len(rows) == 1, rows
print(json.dumps([rows[0], bool(leaves)]))
"#,
            ])
            .output()
            .expect("independent AT-SPI oracle runs");
        assert!(output.status.success(), "oracle: {:?}", output.stderr);
        let observed: (bool, bool) = serde_json::from_slice(&output.stdout).expect("oracle states");
        if observed == expected {
            return;
        }
        assert!(
            started.elapsed() < Duration::from_secs(3),
            "oracle: {observed:?}, expected {expected:?}"
        );
        std::thread::sleep(Duration::from_millis(50));
    }
}

#[test]
#[ignore = "live: needs the AT-SPI session, Files (nautilus) with a folder tree and the write engine"]
fn a_files_tree_row_expands_and_collapses_in_both_directions() {
    let fixture = Fixture::new();
    let session = open(
        "nautilus",
        &["--new-window", fixture.directory.to_str().unwrap()],
    )
    .expect("files opens");
    let row = find(&session, |view| {
        view.state(EXPANDABLE) == Some(true) && view.state(EXPANDED) == Some(false)
    })
    .expect("fixture has a collapsed expandable folder control");
    assert_eq!(state(&session, &row, EXPANDED), Some(false));
    oracle((false, false));
    let opened = act(&session, &row, |target| set_expanded(target, true)).expect("expands");
    assert_eq!(opened.steps[0].verified(), Some(true));
    assert_eq!(state(&session, &row, EXPANDED), Some(true));
    oracle((true, true));
    let leaf = find(&session, |view| view.name() == Some("leaf.txt")).expect("expanded leaf");
    let refused = act(&session, &leaf, |target| set_expanded(target, true))
        .expect_err("a file cannot expand");
    assert_eq!(
        refused.code,
        agent_desktop_core::ErrorCode::ActionNotSupported
    );
    oracle((true, true));
    let closed = act(&session, &row, |target| set_expanded(target, false)).expect("collapses");
    assert_eq!(closed.steps[0].verified(), Some(true));
    assert_eq!(state(&session, &row, EXPANDED), Some(false));
    oracle((false, false));
}

const POPOVER_APP: &str = r#"
import json, os, sys
import gi
gi.require_version("Gtk", "4.0")
from gi.repository import Gtk

STATE = os.path.join(os.path.dirname(os.path.abspath(__file__)), "popover.json")

def write(visible):
    with open(STATE, "w") as handle:
        json.dump({"visible": visible}, handle)

def activate(app):
    window = Gtk.ApplicationWindow(application=app, title="adv-" + sys.argv[1])
    box = Gtk.Box(orientation=Gtk.Orientation.VERTICAL)
    button = Gtk.MenuButton(label="Explain")
    popover = Gtk.Popover()
    popover.set_child(Gtk.Label(label="Explains the thing"))
    popover.connect("notify::visible", lambda widget, _: write(widget.get_visible()))
    button.set_popover(popover)
    box.append(button)
    fake = Gtk.Button(label="Opens nothing")
    fake.update_property([Gtk.AccessibleProperty.HAS_POPUP], [True])
    fake.update_state([Gtk.AccessibleState.EXPANDED], [False])
    box.append(fake)
    window.set_child(box)
    window.present()
    write(False)

app = Gtk.Application(application_id="org.agentdesktop.PopoverFixture")
app.connect("activate", activate)
app.run([])
"#;

#[test]
#[ignore = "drives GTK in scripts/private-session.sh --wm"]
fn a_menu_button_popover_with_only_a_label_expands_and_collapses_in_both_directions() {
    let scripts = Scripts {
        gtk3: "",
        gtk4: POPOVER_APP,
        qt: "",
    };
    let bench = Bench::open_scripts(Toolkit::Gtk4, &scripts).expect("the fixture opens");
    let visible = || {
        let text = std::fs::read_to_string(bench.fixture_file("popover.json")).expect("state");
        serde_json::from_str::<serde_json::Value>(&text).expect("json")["visible"] == true
    };
    let opener = bench.find(PUSH_BUTTON, "Explain").expect("the menu button");
    let opened = bench
        .act(&opener, Action::Expand)
        .expect("a label popover that is open is observed");
    assert_eq!(
        opened.disposition().delivery(),
        DeliveryDisposition::DeliveredVerified
    );
    assert!(visible());
    let again = bench
        .act(&opener, Action::Expand)
        .expect("expanding an open popover is a no-op and no error");
    assert_eq!(
        again.disposition().delivery(),
        DeliveryDisposition::NotDelivered
    );
    assert!(visible());
    let closed = bench
        .act(&opener, Action::Collapse)
        .expect("the open popover collapses");
    assert_eq!(
        closed.disposition().delivery(),
        DeliveryDisposition::DeliveredVerified
    );
    assert!(!visible());
    let fake = bench
        .find(PUSH_BUTTON, "Opens nothing")
        .expect("the button that opens nothing");
    let refused = bench
        .act(&fake, Action::Expand)
        .expect_err("a button that opens nothing shows no popup");
    assert_eq!(
        refused.details.expect("evidence")["kind"],
        "popup_not_observed"
    );
    assert!(!visible());
}
