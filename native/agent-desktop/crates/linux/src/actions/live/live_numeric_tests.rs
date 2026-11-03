use agent_desktop_core::{Action, DeliverySemantics};

use super::live_bench::Bench;
use crate::tree::live::live_launch::{Launched, nonce};

const APP: &str = r#"
import pathlib, sys
import gi
gi.require_version("Gtk", "3.0")
from gi.repository import Gtk
window = Gtk.Window(title=sys.argv[1])
window.connect("destroy", Gtk.main_quit)
scale = Gtk.Scale.new_with_range(Gtk.Orientation.HORIZONTAL, 0, 1000000001, 1)
scale.get_accessible().set_name("Large")
scale.set_value(1000000000)
def record(*_):
    path = pathlib.Path(sys.argv[2])
    temporary = path.with_suffix(".tmp")
    temporary.write_text(str(int(scale.get_value())))
    temporary.replace(path)
scale.connect("value-changed", record)
window.add(scale)
window.show_all()
record()
Gtk.main()
"#;

#[test]
#[ignore = "drives GTK in scripts/private-session.sh --wm"]
fn a_large_clamped_numeric_write_is_delivered_and_an_unchanged_one_is_refused() {
    let mut launched = Launched::new();
    let tag = nonce("large-value");
    let scratch = std::env::temp_dir().join(&tag);
    std::fs::create_dir_all(&scratch).unwrap();
    launched.scratch.push(scratch.clone());
    let state = scratch.join("value");
    let pid = launched.spawn("python3", &["-c", APP, &tag, state.to_str().unwrap()]);
    let adapter = crate::LinuxAdapter::new();
    let frame = Bench::wait_for_frame(&adapter, &tag, pid, 20).expect("GTK window");
    let bench = Bench::attach(launched, frame);
    let scale = bench.named("Large");
    let read = || std::fs::read_to_string(&state).expect("app's value file");
    assert_eq!(read(), "1000000000");
    let result = bench
        .act(&scale, Action::SetValue("2000000000".to_owned()))
        .expect("clamped change");
    assert_eq!(
        result.disposition(),
        DeliverySemantics::delivered_unverified()
    );
    assert_eq!(read(), "1000000001");
    let ignored = bench
        .act(&scale, Action::SetValue("2000000000".to_owned()))
        .expect_err("already clamped");
    assert_eq!(ignored.disposition, DeliverySemantics::not_delivered());
    assert_eq!(read(), "1000000001");
}

const SPIN_APP: &str = r#"
import pathlib, sys
import gi
gi.require_version("Gtk", "3.0")
from gi.repository import Gtk
window = Gtk.Window(title=sys.argv[1])
window.connect("destroy", Gtk.main_quit)
spin = Gtk.SpinButton.new_with_range(0, 100, 1)
spin.get_accessible().set_name("Fraction")
def record(*_):
    path = pathlib.Path(sys.argv[2])
    temporary = path.with_suffix(".tmp")
    temporary.write_text(str(spin.get_value()))
    temporary.replace(path)
spin.connect("value-changed", record)
window.add(spin)
window.show_all()
record()
Gtk.main()
"#;

#[test]
#[ignore = "drives GTK in scripts/private-session.sh --wm"]
fn a_step_one_spin_commits_a_fraction_and_rejects_non_finite_input() {
    let mut launched = Launched::new();
    let tag = nonce("fraction");
    let scratch = std::env::temp_dir().join(&tag);
    std::fs::create_dir_all(&scratch).unwrap();
    launched.scratch.push(scratch.clone());
    let state = scratch.join("value");
    let pid = launched.spawn("python3", &["-c", SPIN_APP, &tag, state.to_str().unwrap()]);
    let adapter = crate::LinuxAdapter::new();
    let frame = Bench::wait_for_frame(&adapter, &tag, pid, 20).expect("GTK window");
    let bench = Bench::attach(launched, frame);
    let spin = bench.named("Fraction");
    let read = || std::fs::read_to_string(&state).expect("app value");
    bench
        .act(&spin, Action::SetValue("7.5".to_owned()))
        .expect("fraction accepted");
    assert!(bench.wait_for(|| (read() == "7.5").then_some(())).is_some());
    let error = bench
        .act(&spin, Action::SetValue("NaN".to_owned()))
        .expect_err("invalid number");
    assert_eq!(error.code, agent_desktop_core::ErrorCode::InvalidArgs);
    assert_eq!(error.disposition, DeliverySemantics::not_delivered());
    assert_eq!(read(), "7.5");
}
