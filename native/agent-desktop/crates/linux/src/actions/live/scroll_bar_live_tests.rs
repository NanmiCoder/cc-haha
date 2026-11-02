use agent_desktop_core::{Deadline, DeliverySemantics, ErrorCode};

use super::live_bench::Bench;
use super::live_scroll_tests::read;
use crate::actions::scroll::scroll_into_view::{BarFound, ScrollPort};
use crate::actions::scroll::scroll_plan::Axis;
use crate::tree::live::live_launch::{Launched, nonce};

const APP: &str = r#"
import json, pathlib, sys
import gi
gi.require_version("Gtk", "3.0")
from gi.repository import Gtk, GLib, Atk
window = Gtk.Window(title=sys.argv[1])
window.connect("destroy", Gtk.main_quit)
box = Gtk.Box(orientation=Gtk.Orientation.HORIZONTAL)
if sys.argv[4] == "direct":
    box.get_accessible().set_role(Atk.Role.SCROLL_PANE)
target = Gtk.Button(label="Target")
box.add(target)
values = [Gtk.Adjustment(value=0, lower=0, upper=100, step_increment=1, page_increment=10, page_size=0) for _ in range(2)]
bars = [Gtk.Scrollbar(orientation=Gtk.Orientation.VERTICAL, adjustment=value) for value in values]
for bar in bars:
    box.add(bar)
def record(*_):
    path = pathlib.Path(sys.argv[2])
    temporary = path.with_suffix(".tmp")
    temporary.write_text(json.dumps({"values": [value.get_value() for value in values], "removed": bars[1].get_parent() is None}))
    temporary.replace(path)
def poll():
    if pathlib.Path(sys.argv[3]).exists() and bars[1].get_parent() is not None:
        box.remove(bars[1])
        record()
    return True
for value in values:
    value.connect("value-changed", record)
window.add(box)
window.show_all()
record()
GLib.timeout_add(20, poll)
Gtk.main()
"#;

#[test]
#[ignore = "drives GTK in scripts/private-session.sh --wm"]
fn tied_scroll_bars_refuse_without_writes_and_a_unique_bar_moves_only_its_value() {
    for route in ["direct", "crawl"] {
        let mut launched = Launched::new();
        let tag = nonce("bars");
        let scratch = std::env::temp_dir().join(&tag);
        std::fs::create_dir_all(&scratch).unwrap();
        launched.scratch.push(scratch.clone());
        let state = scratch.join("state.json");
        let remove = scratch.join("remove");
        let pid = launched.spawn(
            "python3",
            &[
                "-c",
                APP,
                &tag,
                state.to_str().unwrap(),
                remove.to_str().unwrap(),
                route,
            ],
        );
        let adapter = crate::LinuxAdapter::new();
        let frame = Bench::wait_for_frame(&adapter, &tag, pid, 20).expect("GTK window");
        let bench = Bench::attach(launched, frame);
        let target = bench.named("Target");
        let element = crate::tree::atspi_element(&target).unwrap();
        assert_eq!(element.scroll_container().is_some(), route == "direct");
        let port = || {
            crate::actions::scroll::scroll_bus::BusPort::new(
                bench.adapter().bus(),
                &target,
                element,
                Deadline::after(3000).unwrap(),
            )
        };
        let error = port().find_bar(Axis::Vertical).expect_err("two equal bars");
        assert_eq!(error.code, ErrorCode::AmbiguousTarget);
        assert_eq!(error.disposition, DeliverySemantics::not_delivered());
        assert_eq!(read(&state)["values"], serde_json::json!([0.0, 0.0]));
        std::fs::write(&remove, "").unwrap();
        assert!(
            bench
                .wait_for(|| (read(&state)["removed"] == true).then_some(()))
                .is_some()
        );
        let mut port = port();
        assert!(matches!(
            port.find_bar(Axis::Vertical).unwrap(),
            BarFound::Found { .. }
        ));
        port.write(37.0).expect("the unique bar accepts a write");
        assert!(
            bench
                .wait_for(
                    || (read(&state)["values"] == serde_json::json!([37.0, 0.0])).then_some(())
                )
                .is_some()
        );
    }
}
