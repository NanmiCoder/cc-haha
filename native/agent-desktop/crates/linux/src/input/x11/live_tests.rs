use std::process::Command;
use std::time::{Duration, Instant};

use agent_desktop_core::Deadline;

use super::live_remap_tests::observed_keymap;
use super::session::run;
use crate::input::keyboard::keymap::Keymap;
use crate::input::plan::Plan;
use crate::input::step::Step;

const SETTLE: Duration = Duration::from_secs(30);

pub(crate) const GTK3: &str = r#"
import gi, os
gi.require_version("Gtk", "3.0")
from gi.repository import Gtk
log = os.environ["AD_LIVE_LOG"]
w = Gtk.Window(title="adx")
w.set_default_size(320, 80)
e = Gtk.Entry()
e.connect("changed", lambda x: open(log, "w").write(x.get_text()))
w.add(e)
w.connect("destroy", Gtk.main_quit)
w.show_all()
Gtk.main()
"#;

pub(crate) fn window_center(name: &str) -> (i32, i32) {
    let started = Instant::now();
    while started.elapsed() < SETTLE {
        let output = Command::new("xwininfo").args(["-name", name]).output();
        if let Ok(output) = output {
            let text = String::from_utf8_lossy(&output.stdout);
            let field = |label: &str| {
                text.lines()
                    .find_map(|line| line.trim().strip_prefix(label))
                    .and_then(|rest| rest.trim().parse::<i32>().ok())
            };
            if let (Some(x), Some(y), Some(w), Some(h)) = (
                field("Absolute upper-left X:"),
                field("Absolute upper-left Y:"),
                field("Width:"),
                field("Height:"),
            ) {
                return (x + w / 2, y + h / 2);
            }
        }
        std::thread::sleep(Duration::from_millis(200));
    }
    panic!("window {name} never appeared");
}

pub(crate) fn deadline(ms: u64) -> Deadline {
    Deadline::detached_after(ms).expect("deadline")
}

pub(crate) fn spawn_helper(test: &str, flag: &str) -> std::process::Child {
    use agent_desktop_core::INTERACTION_LEASE_FD_ENV;
    use std::os::fd::AsRawFd;

    let inherited = std::env::var_os(INTERACTION_LEASE_FD_ENV).map(|_| {
        let lease = crate::system::interaction::interaction_lease::acquire(deadline(8_000))
            .expect("the caller's lease");
        lease
            .duplicate_inheritable_fd()
            .expect("the helper's lease")
    });
    let mut command = Command::new(std::env::current_exe().expect("exe"));
    command
        .args(["--exact", test, "--include-ignored", "--nocapture"])
        .env(flag, "1");
    if let Some(fd) = &inherited {
        command.env(INTERACTION_LEASE_FD_ENV, fd.as_raw_fd().to_string());
    }
    command.spawn().expect("helper")
}

const OWN_DISPLAY_ENV: &str = "AD_OWN_DISPLAY";

pub(crate) fn refuse_live_display(display: &str) {
    let name = display.split('.').next().unwrap_or_default();
    assert!(
        !display.is_empty() && !matches!(name, ":0" | ":1" | ":99"),
        "refusing the display {display:?}: live tests take their display only from a private session"
    );
}

pub(crate) fn private_display() -> String {
    let dir = std::env::var("AGENT_DESKTOP_PRIVATE_SESSION")
        .expect("live input tests run only inside scripts/private-session.sh");
    let current = std::env::var("DISPLAY").unwrap_or_default();
    refuse_live_display(&current);
    let private = match std::env::var(OWN_DISPLAY_ENV) {
        Ok(own) => own,
        Err(_) => {
            let number = std::fs::read_to_string(format!("{dir}/displayfd")).expect("displayfd");
            format!(":{}", number.trim())
        }
    };
    assert_eq!(
        current, private,
        "input is sent only to the private session's display"
    );
    current
}

fn keycode_for(map: &Keymap, keysym: u32) -> u8 {
    let width = usize::from(map.keysyms_per_keycode);
    let index = map
        .keysyms
        .chunks(width)
        .position(|row| row.first() == Some(&keysym))
        .unwrap_or_else(|| panic!("keysym {keysym:#x} is not on level one"));
    map.min_keycode + u8::try_from(index).expect("keycode")
}

pub(crate) fn device_state(device: &str) -> String {
    let output = Command::new("xinput")
        .args(["query-state", device])
        .output()
        .expect("xinput runs");
    assert!(output.status.success(), "xinput failed: {output:?}");
    String::from_utf8(output.stdout).expect("xinput state is UTF-8")
}

const ESCAPE_KEYSYM: u32 = 0xff1b;
const POPUP_CLOSE_BUDGET: Duration = Duration::from_secs(5);

/// Whether GNOME Shell's own stage window owns the keyboard focus, which is
/// what an open shell popup leaves behind: the window manager then activates
/// no window until the popup closes.
pub(crate) fn shell_stage_has_focus() -> bool {
    Command::new("xdotool")
        .args(["getwindowfocus", "getwindowname"])
        .output()
        .is_ok_and(|output| String::from_utf8_lossy(&output.stdout).trim() == "gnome-shell")
}

fn dismiss_shell_popup(display: &str) -> Result<(), String> {
    if !shell_stage_has_focus() {
        return Ok(());
    }
    let code = keycode_for(&observed_keymap(display), ESCAPE_KEYSYM);
    let escape = Plan {
        steps: vec![
            Step::Key { code, down: true },
            Step::Key { code, down: false },
        ],
        release_origin: None,
    };
    let lease = crate::system::interaction::interaction_lease::acquire(deadline(8_000))
        .map_err(|error| format!("{error:?}"))?;
    run(display, vec![escape], &mut || Ok(()), &lease).map_err(|error| format!("{error:?}"))?;
    let started = Instant::now();
    while shell_stage_has_focus() {
        if started.elapsed() >= POPUP_CLOSE_BUDGET {
            return Err("GNOME Shell kept the keyboard focus after Escape".to_owned());
        }
        std::thread::sleep(Duration::from_millis(100));
    }
    Ok(())
}

/// A button held for about half a second on the desktop background is a long
/// press to GNOME Shell, which opens its background menu and keeps it open
/// for every later test of the session. The guard closes that menu when the
/// test ends, on a failure too.
struct ClosesShellPopup<'a>(&'a str);

impl ClosesShellPopup<'_> {
    fn close(&self) -> Result<(), String> {
        dismiss_shell_popup(self.0)
    }
}

impl Drop for ClosesShellPopup<'_> {
    fn drop(&mut self) {
        let display = self.0;
        let _ = std::panic::catch_unwind(|| dismiss_shell_popup(display));
    }
}

fn input_down(device: &str, input: &str) -> bool {
    let text = device_state(device);
    let state = text.lines().find_map(|line| {
        let (name, state) = line.trim().split_once('=')?;
        (name == input).then_some(state)
    });
    match state {
        Some("down") => true,
        Some("up") => false,
        _ => panic!("xinput did not report {input} up or down: {text}"),
    }
}

#[test]
#[ignore = "needs scripts/private-session.sh --wm"]
fn live_a_key_left_held_by_a_killed_client_is_released_by_the_next_call() {
    let display = private_display();
    if std::env::var("AD_HOLD_HELPER").is_ok() {
        let map = observed_keymap(&display);
        let code = keycode_for(&map, u32::from('a'));
        let hold = Plan {
            steps: vec![
                Step::Key { code, down: true },
                Step::Button {
                    code: 1,
                    down: true,
                },
                Step::Pause(Duration::from_secs(60)),
            ],
            release_origin: None,
        };
        let lease = crate::system::interaction::interaction_lease::acquire(deadline(70_000))
            .expect("lease");
        let _ = run(&display, vec![hold], &mut || Ok(()), &lease);
        return;
    }
    let popup = ClosesShellPopup(&display);
    let map = observed_keymap(&display);
    let code = keycode_for(&map, u32::from('a'));
    let device = "Virtual core XTEST keyboard";
    let mut child = spawn_helper(
        "input::x11::live_tests::live_a_key_left_held_by_a_killed_client_is_released_by_the_next_call",
        "AD_HOLD_HELPER",
    );
    let key = format!("key[{code}]");
    let pointer = "Virtual core XTEST pointer";
    let button = "button[1]";
    let started = Instant::now();
    while !(input_down(device, &key) && input_down(pointer, button)) {
        assert!(
            started.elapsed() < Duration::from_secs(20),
            "key never went down"
        );
        std::thread::sleep(Duration::from_millis(100));
    }
    let pid = child.id();
    Command::new("kill")
        .args(["-KILL", &pid.to_string()])
        .status()
        .expect("kill");
    let _ = child.wait();
    std::thread::sleep(Duration::from_millis(500));
    assert!(
        input_down(device, &key) && input_down(pointer, button),
        "the server released the input by itself, so the journal is not needed"
    );
    let nudge = Plan {
        steps: vec![Step::MoveTo { x: 3, y: 3 }],
        release_origin: None,
    };
    let lease =
        crate::system::interaction::interaction_lease::acquire(deadline(8_000)).expect("lease");
    run(&display, vec![nudge], &mut || Ok(()), &lease).expect("next call");
    drop(lease);
    assert!(
        !input_down(device, &key) && !input_down(pointer, button),
        "the next call did not release the input a killed client left held"
    );
    popup
        .close()
        .expect("the shell popup the held button opened closes");
}
