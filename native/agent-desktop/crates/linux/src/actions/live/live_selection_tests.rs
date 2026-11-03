use agent_desktop_core::{Action, Deadline, DeliverySemantics, ObservationOps};

use super::live_bench::Bench;
use crate::tree::live::live_launch::{Launched, nonce};

const APP: &str = r#"
import json, pathlib, sys
import gi
gi.require_version("Gtk", "3.0")
from gi.repository import Gtk
window = Gtk.Window(title=sys.argv[1])
window.connect("destroy", Gtk.main_quit)
items = Gtk.ListBox()
items.set_selection_mode(Gtk.SelectionMode.MULTIPLE)
items.get_accessible().set_name("Items")
rows = []
for name in ["Alpha", "Beta"]:
    row = Gtk.ListBoxRow()
    row.get_accessible().set_name(name)
    row.add(Gtk.Label(label=name))
    items.add(row)
    rows.append(row)
window.add(items)
window.show_all()
items.select_row(rows[0])
def record(*_):
    selected = items.get_selected_rows()
    if not selected and sys.argv[3] == "withdraw":
        rows[1].destroy()
    path = pathlib.Path(sys.argv[2])
    temporary = path.with_suffix(".tmp")
    temporary.write_text(json.dumps([r.get_accessible().get_name() for r in selected]))
    temporary.replace(path)
items.connect("selected-rows-changed", record)
record()
Gtk.main()
"#;

#[test]
#[ignore = "drives GTK in scripts/private-session.sh --wm"]
fn selection_replacement_reports_a_row_withdrawn_after_clear_and_selects_a_stable_row() {
    for mode in ["stable", "withdraw", "row"] {
        let mut launched = Launched::new();
        let tag = nonce("selection");
        let scratch = std::env::temp_dir().join(&tag);
        std::fs::create_dir_all(&scratch).unwrap();
        launched.scratch.push(scratch.clone());
        let state = scratch.join("selected.json");
        let pid = launched.spawn("python3", &["-c", APP, &tag, state.to_str().unwrap(), mode]);
        let adapter = crate::LinuxAdapter::new();
        let frame = Bench::wait_for_frame(&adapter, &tag, pid, 20).expect("GTK window");
        let bench = Bench::attach(launched, frame);
        let items = bench.named(if mode == "row" { "Beta" } else { "Items" });
        if mode == "row" {
            let live = bench
                .adapter()
                .get_live_element(&items, Deadline::after(5000).unwrap())
                .unwrap();
            assert!(
                live.available_actions
                    .iter()
                    .any(|action| action == "Select")
            );
        }
        let read = || {
            serde_json::from_str::<Vec<String>>(&std::fs::read_to_string(&state).unwrap()).unwrap()
        };
        assert_eq!(read(), ["Alpha"]);
        let outcome = bench.act(&items, Action::Select("Beta".to_owned()));
        if mode == "withdraw" {
            let error = outcome.expect_err("row vanishes after clear");
            assert_eq!(error.disposition, DeliverySemantics::uncertain());
            assert!(read().is_empty());
        } else {
            outcome.expect("exclusive Beta selection");
            assert_eq!(read(), ["Beta"]);
            let before = read();
            bench
                .act(&items, Action::Select("Missing".to_owned()))
                .expect_err("missing row");
            assert_eq!(read(), before);
            if mode == "row" {
                bench
                    .act(&bench.named("Alpha"), Action::Select("Alpha".to_owned()))
                    .expect("select the first row again through its parent");
                assert_eq!(read(), ["Alpha"]);
            }
        }
    }
}
