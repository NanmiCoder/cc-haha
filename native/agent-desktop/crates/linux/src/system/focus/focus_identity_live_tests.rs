use std::time::{Duration, Instant};

use super::focus_window::FocusWorld;
use super::focus_window::lift_live_tests::{deadline, focus, spawn_with, xid_of, xprop};
use super::focus_world::LiveWorld;
use crate::system::SharedBus;
use crate::tree::live::live_launch::Launched;

fn active() -> u32 {
    let text = xprop(&["-root", "_NET_ACTIVE_WINDOW"]);
    u32::from_str_radix(
        text.split_whitespace()
            .last()
            .expect("active XID")
            .trim_start_matches("0x"),
        16,
    )
    .expect("hex XID")
}

fn wait_active(expected: u32) {
    let started = Instant::now();
    while active() != expected {
        assert!(started.elapsed() < Duration::from_secs(5), "focus readback");
        std::thread::sleep(Duration::from_millis(20));
    }
}

#[test]
#[ignore = "activates private GTK windows; run inside scripts/private-session.sh --wm"]
fn focus_sends_recheck_the_xid_owner_and_process_instance() {
    let bus = SharedBus::default();
    let mut launched = Launched::new();
    let target = spawn_with(&mut launched, &bus, "owner-target", false);
    let other = spawn_with(&mut launched, &bus, "owner-other", false);
    let xid = xid_of(target.pid.get());
    let client = u32::from_str_radix(xid.trim_start_matches("0x"), 16).expect("client");
    let other_xid = xid_of(other.pid.get());
    let other_client = u32::from_str_radix(other_xid.trim_start_matches("0x"), 16).expect("other");
    for untimed in [false, true] {
        for _ in 0..2 {
            focus(&bus, &other).expect("focus control");
            wait_active(other_client);
            let world = LiveWorld::new(&bus, &target, deadline(5_000)).expect("target world");
            xprop(&[
                "-id",
                &xid,
                "-f",
                "_NET_WM_PID",
                "32c",
                "-set",
                "_NET_WM_PID",
                &other.pid.to_string(),
            ]);
            let refused = if untimed {
                world.send_untimed(client)
            } else {
                world.send(client)
            };
            assert!(
                refused.is_err(),
                "a replaced XID must receive no activation"
            );
            std::thread::sleep(Duration::from_millis(100));
            assert_eq!(active(), other_client, "replacement must not gain focus");
            xprop(&[
                "-id",
                &xid,
                "-f",
                "_NET_WM_PID",
                "32c",
                "-set",
                "_NET_WM_PID",
                &target.pid.to_string(),
            ]);
            let mut stale = target.clone();
            stale.process_instance = Some("replaced".to_owned());
            let stale_world = LiveWorld::new(&bus, &stale, deadline(5_000)).expect("stale world");
            let refused = if untimed {
                stale_world.send_untimed(client)
            } else {
                stale_world.send(client)
            };
            assert!(
                refused.is_err(),
                "a replaced process must receive no activation"
            );
            assert_eq!(active(), other_client);
            let sent = if untimed {
                world.send_untimed(client)
            } else {
                world.send(client)
            };
            sent.expect("current owner receives activation");
            wait_active(client);
        }
    }
}
