use crate::system::menu::menu_live_rig::Rig;
use crate::tree::live::live_launch::Launched;
use serde_json::Value;
use std::process::Command;
use std::time::Duration;

fn cli(arguments: &[&str]) -> Value {
    let executable = std::env::var("AGENT_DESKTOP_TEST_BINARY").expect("production CLI path");
    let output = Command::new(executable).args(arguments).output().unwrap();
    serde_json::from_slice(&output.stdout).unwrap_or_else(|error| {
        panic!(
            "CLI JSON: {error}; stdout={} stderr={}",
            String::from_utf8_lossy(&output.stdout),
            String::from_utf8_lossy(&output.stderr)
        )
    })
}

#[test]
#[ignore = "production CLI plus real GTK checkbox; run in scripts/private-session.sh --wm"]
fn satisfied_check_does_not_delay_a_closed_menu_but_delivery_still_does() {
    let runtime = std::path::PathBuf::from(
        std::env::var("AGENT_DESKTOP_PRIVATE_SESSION").expect("private session"),
    );
    let script = runtime.join("clock-app.py");
    let state = runtime.join("clock-state");
    std::fs::write(
        &script,
        r#"
import gi, sys
gi.require_version('Gtk', '3.0')
from gi.repository import Gtk
w = Gtk.Window(title='clock-app')
check = Gtk.CheckButton(label='Flag')
check.set_active(True)
def record(*_):
    with open(sys.argv[1], 'w') as f: f.write(str(check.get_active()))
check.connect('toggled', record)
record()
w.add(check)
w.connect('destroy', Gtk.main_quit)
w.show_all()
Gtk.main()
"#,
    )
    .unwrap();

    let mut launched = Launched::new();
    let pid = launched.spawn(
        "python3",
        &[script.to_str().unwrap(), state.to_str().unwrap()],
    );
    let rig = Rig::attach(pid);
    let window = rig.window();
    let found = cli(&[
        "find",
        "--window-id",
        &window.id,
        "--role",
        "checkbox",
        "--name",
        "Flag",
        "--exact",
        "--first",
    ]);
    assert_eq!(found["ok"], true, "{found}");
    let reference = found["data"]["match"]["ref_id"]
        .as_str()
        .expect("checkbox ref");
    let element = rig
        .raw_find(&[7], "Flag")
        .expect("independent checkbox address");
    for _ in 0..2 {
        assert_eq!(std::fs::read_to_string(&state).unwrap(), "True");
        assert_eq!(rig.open_item_count(), 0);
        let record = runtime.join("agent-desktop-actions").join(pid.to_string());
        let before = std::fs::read(&record).ok();
        let checked = cli(&["check", reference]);
        assert_eq!(checked["ok"], true, "{checked}");
        assert_eq!(checked["data"]["disposition"]["delivery"], "not_delivered");
        assert_eq!(
            std::fs::read(&record).ok(),
            before,
            "successful no-op preserves the on-disk action timestamp"
        );
        let closed = cli(&[
            "wait",
            "--menu-closed",
            "--app",
            &window.app,
            "--timeout",
            "1000",
        ]);
        assert_eq!(
            closed["ok"], true,
            "successful no-op must not extend popup grace: {closed}"
        );
        assert_eq!(std::fs::read_to_string(&state).unwrap(), "True");
        let unchecked = cli(&["uncheck", reference]);
        assert_eq!(unchecked["ok"], true, "{unchecked}");
        assert_ne!(
            unchecked["data"]["disposition"]["delivery"],
            "not_delivered"
        );
        assert_ne!(
            std::fs::read(&record).ok(),
            before,
            "delivered uncheck records a new action on disk"
        );
        crate::system::menu::menu_live_rig::poll("independent checkbox handler file", || {
            (std::fs::read_to_string(&state).ok().as_deref() == Some("False")).then_some(())
        });
        let refused = cli(&[
            "wait",
            "--menu-closed",
            "--app",
            &window.app,
            "--timeout",
            "250",
        ]);
        assert_eq!(
            refused["error"]["code"], "TIMEOUT",
            "delivered action must retain popup grace: {refused}"
        );
        assert_eq!(rig.open_item_count(), 0);
        println!(
            "production CLI across invocations + GTK handler file + direct AT-SPI: no-op check preserves True and closed wait succeeds; delivered uncheck writes False and short closed wait refuses"
        );
        rig.do_action(&element);
        crate::system::menu::menu_live_rig::poll("independent recheck", || {
            (std::fs::read_to_string(&state).ok().as_deref() == Some("True")).then_some(())
        });
        std::thread::sleep(Duration::from_millis(2100));
    }
}
