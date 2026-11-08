use super::{Deadline, SessionBus, shell_pid, within};
use crate::system::shell::fake_tree::{FakeTree, PANEL, SENTINEL, WINDOW, at, element};
use crate::system::shell::identity::{
    content_window, pick_shell_app, retries_after, retry_until, window_missing,
};
use crate::tree::AtspiElement;

fn app(bus: &str, pid: u32) -> (AtspiElement, u32) {
    (AtspiElement::new(bus, "/root", pid), pid)
}

#[test]
fn the_shell_app_is_the_one_owned_by_the_shell_process() {
    let apps = [app(":1.2", 10), app(":1.3", 20), app(":1.4", 30)];
    let picked = pick_shell_app(&apps, 20).expect("pid 20 owns an app");
    assert_eq!(picked.bus_name(), ":1.3");
    assert!(pick_shell_app(&apps, 99).is_none());
    assert!(pick_shell_app(&[app(":1.2", 20), app(":1.3", 20)], 20).is_none());
}

#[test]
fn the_content_window_is_the_child_with_a_placed_rectangle() {
    let mut tree = FakeTree::new();
    tree.add(None, "/root", 75, "gnome-shell", at(0, 0, 0, 0));
    tree.add(Some("/root"), "/decor", PANEL, "", SENTINEL);
    tree.add(Some("/root"), "/w", WINDOW, "", at(0, 54, 87, 55));
    let window = content_window(&tree, &element("/root"))
        .expect("a readable app")
        .expect("a window child");
    assert_eq!(window.path(), "/w");
}

#[test]
fn an_app_with_no_placed_child_has_no_content_window() {
    let mut tree = FakeTree::new();
    tree.add(None, "/root", 75, "gnome-shell", at(0, 0, 0, 0));
    tree.add(Some("/root"), "/decor", PANEL, "", SENTINEL);
    assert!(
        content_window(&tree, &element("/root"))
            .expect("a readable app")
            .is_none()
    );
}

#[test]
fn a_placed_shell_child_is_content_whatever_its_role() {
    for role in [PANEL, 16, 43] {
        let mut tree = FakeTree::new();
        tree.add(None, "/root", 75, "gnome-shell", at(0, 0, 0, 0));
        tree.add(Some("/root"), "/content", role, "", at(0, 54, 87, 55));
        assert_eq!(
            content_window(&tree, &element("/root")).unwrap(),
            Some(element("/content"))
        );
    }
}

#[test]
fn a_destroyed_sibling_does_not_hide_the_live_content_window() {
    let mut tree = FakeTree::new();
    tree.add(None, "/root", 75, "gnome-shell", at(0, 0, 0, 0));
    tree.add(Some("/root"), "/decor", PANEL, "", SENTINEL);
    tree.add(Some("/root"), "/w", WINDOW, "", at(0, 54, 87, 55));
    tree.vanish("/decor");
    let window = content_window(&tree, &element("/root"))
        .expect("the live sibling is still readable")
        .expect("the content window");
    assert_eq!(window.path(), "/w");
}

#[test]
fn multiple_shell_windows_are_ambiguous_instead_of_selected_by_child_order() {
    let mut tree = FakeTree::new();
    tree.add(None, "/root", 75, "", at(0, 0, 0, 0));
    tree.add(Some("/root"), "/a", WINDOW, "", at(0, 0, 1, 1));
    tree.add(Some("/root"), "/b", PANEL, "", at(0, 0, 1, 1));
    assert_eq!(
        content_window(&tree, &element("/root")).unwrap_err().code,
        agent_desktop_core::ErrorCode::AmbiguousTarget
    );
}

fn deadline() -> agent_desktop_core::Deadline {
    agent_desktop_core::Deadline::after(10_000).expect("a deadline")
}

#[test]
fn a_window_that_comes_back_within_the_retries_is_found() {
    let mut misses = 3;
    let mut pauses = 0;
    let found = retry_until(10, deadline(), &mut |_| pauses += 1, || {
        if misses == 0 {
            Some("window")
        } else {
            misses -= 1;
            None
        }
    });
    assert_eq!(found, Some("window"));
    assert_eq!(pauses, 3);
}

#[test]
fn a_window_that_never_comes_back_is_none_after_the_bounded_retries() {
    let mut pauses = 0;
    let found: Option<()> = retry_until(10, deadline(), &mut |_| pauses += 1, || None);
    assert!(found.is_none());
    assert_eq!(pauses, 10);
}

#[test]
fn the_retries_stop_at_a_spent_deadline() {
    let spent = agent_desktop_core::Deadline::after(1).expect("a deadline");
    std::thread::sleep(std::time::Duration::from_millis(10));
    let mut pauses = 0;
    let found: Option<()> = retry_until(10, spent, &mut |_| pauses += 1, || None);
    assert!(found.is_none());
    assert_eq!(pauses, 0);
}

#[test]
fn a_missing_shell_window_is_named_apart_from_an_absent_shell_and_is_safe_to_retry() {
    let error = window_missing();
    assert_eq!(error.code, agent_desktop_core::ErrorCode::AppNotFound);
    let details = error.details.expect("details");
    assert_eq!(details["shell_tree"], "window_missing");
    assert_eq!(details["retryable"], true);
    assert_eq!(
        error.disposition,
        agent_desktop_core::DeliverySemantics::not_delivered()
    );
}

#[test]
fn absent_gnome_capability_guidance_names_the_requirement_without_a_restart() {
    let error = super::tree_absent("org.gnome.Shell has no owner on the session bus");
    assert_eq!(error.code, agent_desktop_core::ErrorCode::AppNotFound);
    assert!(
        error
            .message
            .contains("GNOME Shell accessibility capability")
    );
    let suggestion = error.suggestion.expect("capability guidance");
    assert!(suggestion.contains("GNOME Shell session"));
    assert!(suggestion.contains("org.gnome.Shell"));
    assert!(!suggestion.to_lowercase().contains("restart"));
    assert_eq!(
        error.details.expect("absence evidence")["shell_tree"],
        "absent"
    );
}

#[test]
fn a_lookup_in_the_same_outage_probes_once_and_a_fresh_one_retries() {
    let now = std::time::Instant::now();
    assert_eq!(retries_after(Some(now), now), 0);
    assert_eq!(retries_after(None, now), 10);
    let long_ago = now - std::time::Duration::from_millis(5_000);
    assert_eq!(retries_after(Some(long_ago), now), 10);
}

#[test]
#[ignore = "closes only an owned client connection; run in scripts/private-session.sh"]
fn shell_pid_transport_loss_reopens_the_cached_session_connection() {
    assert!(std::env::var_os("AGENT_DESKTOP_PRIVATE_SESSION").is_some());
    for _ in 0..2 {
        let deadline = Deadline::after(5000).unwrap();
        let session = SessionBus::get(deadline).unwrap();
        let previous = session.unique_name().unwrap().to_owned();
        let oracle = std::process::Command::new("busctl")
            .args([
                "--address",
                &std::env::var("DBUS_SESSION_BUS_ADDRESS").unwrap(),
                "call",
                "org.freedesktop.DBus",
                "/org/freedesktop/DBus",
                "org.freedesktop.DBus",
                "GetConnectionUnixProcessID",
                "s",
                "org.gnome.Shell",
            ])
            .output()
            .unwrap();
        let expected_pid = oracle.status.success().then(|| {
            String::from_utf8_lossy(&oracle.stdout)
                .split_whitespace()
                .next_back()
                .unwrap()
                .parse::<u32>()
                .unwrap()
        });
        within(deadline, async {
            session
                .clone()
                .close()
                .await
                .map_err(|e| crate::system::classify(&e))
        })
        .unwrap();
        assert!(within(deadline, shell_pid(&session)).is_err());
        let reopened = SessionBus::get(deadline).expect("fresh client");
        assert_ne!(
            reopened.unique_name().unwrap(),
            &previous,
            "failed shell transport evicts cached connection"
        );
        let output = std::process::Command::new("busctl")
            .args([
                "--address",
                &std::env::var("DBUS_SESSION_BUS_ADDRESS").unwrap(),
                "--no-pager",
                "list",
            ])
            .output()
            .unwrap();
        assert!(output.status.success());
        assert!(
            String::from_utf8_lossy(&output.stdout)
                .contains(reopened.unique_name().unwrap().as_str())
        );
        assert_eq!(
            within(deadline, shell_pid(&reopened)).unwrap(),
            expected_pid,
            "shell lookup agrees with independent busctl after reconnection"
        );
        let kept = SessionBus::get(deadline).unwrap();
        assert_eq!(kept.unique_name(), reopened.unique_name());
        if let Some(pid) = expected_pid {
            let root = super::find_root(
                &crate::system::SharedBus::default(),
                Deadline::after(5000).unwrap(),
            )
            .expect("live shell tree reconnects");
            assert_eq!(root.pid, pid);
        }
        println!(
            "busctl confirms new live client {} after closing {previous}; healthy shell lookup keeps client",
            reopened.unique_name().unwrap()
        );
    }
}
