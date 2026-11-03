use std::time::{Duration, Instant};

use agent_desktop_core::{Deadline, ErrorCode, WindowFilter};

use crate::system::{SharedBus, list_windows, window::window_id};
use crate::tree::{AtspiElement, live::live_launch::Launched};

#[test]
#[ignore = "reads a large private GTK window through the real AT-SPI bus"]
fn a_truncated_window_never_proves_that_no_menu_is_open() {
    let runtime = std::env::var("AGENT_DESKTOP_PRIVATE_SESSION").expect("private session");
    let script = format!("{runtime}/menu-inventory.py");
    std::fs::write(
        &script,
        r#"
import gi, sys
gi.require_version('Gtk', '3.0')
from gi.repository import Gtk
w = Gtk.Window(title='menu inventory')
box = Gtk.Box(orientation=Gtk.Orientation.VERTICAL)
for i in range(int(sys.argv[1])):
    box.pack_start(Gtk.Label(label=str(i)), False, False, 0)
scroll = Gtk.ScrolledWindow()
scroll.add(box)
w.add(scroll)
w.set_default_size(400, 300)
w.connect('destroy', Gtk.main_quit)
w.show_all()
Gtk.main()
"#,
    )
    .expect("fixture");
    let mut launched = Launched::new();
    let bus = SharedBus::default();
    for count in [3, 2100] {
        let pid = launched.spawn("python3", &[&script, &count.to_string()]);
        let started = Instant::now();
        let window = loop {
            if let Some(window) = list_windows(
                &bus,
                &WindowFilter {
                    focused_only: false,
                    app: None,
                },
                Deadline::after(30_000).expect("budget"),
            )
            .unwrap_or_default()
            .into_iter()
            .find(|window| window.pid == pid)
            {
                break window;
            }
            assert!(
                started.elapsed() < Duration::from_secs(40),
                "window readiness"
            );
            std::thread::sleep(Duration::from_millis(100));
        };
        let oracle = std::process::Command::new("python3")
            .args([
                "-c",
                r#"
import gi, sys
gi.require_version('Atspi', '2.0')
from gi.repository import Atspi
desktop = Atspi.get_desktop(0)
app = next(desktop.get_child_at_index(i) for i in range(desktop.get_child_count()) if desktop.get_child_at_index(i).get_process_id() == int(sys.argv[1]))
def widest(node):
    n = node.get_child_count()
    return max([n] + [widest(node.get_child_at_index(i)) for i in range(n)])
assert widest(app) >= int(sys.argv[2])
"#,
                &pid.to_string(),
                &count.to_string(),
            ])
            .status()
            .expect("independent AT-SPI oracle");
        assert!(oracle.success());
        let (name, path) = window_id::decode(&window.id).expect("window identity");
        let element = AtspiElement::new(name, path, pid);
        let outcome = super::menu_surface::popups_at(
            &bus,
            &element,
            Deadline::after(60_000).expect("budget"),
        );
        if count == 3 {
            assert!(outcome.expect("complete absence").is_empty());
        } else {
            let error = outcome.err().expect("incomplete absence is not proof");
            assert_eq!(error.code, ErrorCode::Timeout);
            assert!(error.message.contains("menu inventory"));
        }
    }
}
