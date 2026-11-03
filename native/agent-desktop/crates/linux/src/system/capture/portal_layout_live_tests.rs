use super::*;

#[test]
#[ignore = "changes one private virtual monitor during portal consent"]
fn a_one_monitor_layout_change_during_consent_returns_no_pixels() {
    let world = boot_with(&["2560x1600"]);
    let before_files = home_screenshots();
    let before = crate::system::list_wayland_displays(Deadline::after(10_000).expect("budget"))
        .expect("initial layout");
    assert_eq!(before.len(), 1);
    let changed = capture_while(&world, 60_000, |keys| {
        set_first_scale(2.0).expect("change the private monitor scale");
        let oracle = std::process::Command::new("python3").args(["-c", r#"
import gi
from gi.repository import Gio
bus = Gio.bus_get_sync(Gio.BusType.SESSION, None)
state = bus.call_sync('org.gnome.Mutter.DisplayConfig', '/org/gnome/Mutter/DisplayConfig', 'org.gnome.Mutter.DisplayConfig', 'GetCurrentState', None, None, Gio.DBusCallFlags.NONE, 5000, None).unpack()
assert len(state[2]) == 1 and state[2][0][2] == 2.0, state
"#]).status().expect("independent monitor oracle");
        assert!(oracle.success());
        keys.press(KEY_TAB);
        std::thread::sleep(Duration::from_millis(400));
        keys.press(KEY_RETURN);
    }).expect_err("the changed layout must release no pixels");
    assert_eq!(changed.code, ErrorCode::ActionFailed);
    assert!(changed.message.contains("layout changed"));
    assert_eq!(home_screenshots(), before_files);
    let image = capture_target(&world, &ScreenshotTarget::FullScreen)
        .expect("an unchanged one-monitor baseline still captures");
    assert_eq!(blue_pixels(&image.data).0, 2560);
    assert_eq!(home_screenshots(), before_files);
}
