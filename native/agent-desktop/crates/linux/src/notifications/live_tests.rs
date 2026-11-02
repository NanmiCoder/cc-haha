use agent_desktop_core::{
    Deadline, DismissAllNotificationsRequest, DismissNotificationRequest, InteractionLease,
    InteractionPolicy, NotificationActionRequest, NotificationFilter, NotificationIdentity,
    SystemOps,
};
use std::process::Command;
use std::time::Duration;

use super::signal::{BusSignals, Signal, SignalSource};
use crate::system::SharedBus;

fn oracle(args: &[&str]) -> String {
    let script = concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/../../scripts/notification-oracle.sh"
    );
    let out = Command::new("bash")
        .arg(script)
        .args(args)
        .output()
        .expect("oracle");
    assert!(
        out.status.success(),
        "{}",
        String::from_utf8_lossy(&out.stderr)
    );
    String::from_utf8_lossy(&out.stdout).trim().to_owned()
}

fn notify(app: &str, summary: &str, actions: &str) -> u32 {
    oracle(&["notify", app, summary, "body", actions])
        .parse()
        .expect("id")
}

fn lease() -> InteractionLease {
    crate::LinuxAdapter::new()
        .acquire_interaction_lease(Deadline::after(60_000).expect("deadline"))
        .expect("lease")
}

fn deadline() -> Deadline {
    Deadline::after(30_000).expect("deadline")
}

fn listed(bus: &SharedBus) -> Vec<agent_desktop_core::NotificationInfo> {
    super::list(
        bus,
        &NotificationFilter::default(),
        InteractionPolicy::headless(),
        deadline(),
        None,
    )
    .expect("listed")
}

fn identity_of(info: &agent_desktop_core::NotificationInfo) -> NotificationIdentity {
    NotificationIdentity {
        expected_app: Some(info.app_name.clone()),
        expected_title: Some(info.title.clone()),
    }
}

#[test]
#[ignore = "needs the private gnome-shell of scripts/notification-live.sh"]
fn signals_subscribed_before_a_close_arrive_and_after_it_do_not() {
    let early = BusSignals.subscribe(deadline()).expect("subscribed");
    let id = notify("live-signals", "closed early", "");
    oracle(&["close", &id.to_string()]);
    let seen = early.collect(Duration::from_secs(3));
    assert!(seen.contains(&Signal::Closed(id)), "{seen:?}");

    let id = notify("live-signals", "closed before the rule", "");
    oracle(&["close", &id.to_string()]);
    let late = BusSignals.subscribe(deadline()).expect("subscribed");
    assert!(late.collect(Duration::from_secs(2)).is_empty());
}

#[test]
#[ignore = "needs the private gnome-shell of scripts/notification-live.sh"]
fn list_matches_what_the_sender_posted() {
    let bus = SharedBus::default();
    notify("live-mail", "first", "k1=Run A");
    notify("live-chat", "second", "");
    let entries = listed(&bus);
    assert_eq!(entries[0].title, "second");
    assert_eq!(entries[1].title, "first");
    assert_eq!(entries[1].actions, vec!["Run A"]);
}

#[test]
#[ignore = "needs the private gnome-shell of scripts/notification-live.sh"]
fn an_entry_that_has_gone_is_not_found() {
    let bus = SharedBus::default();
    let id = notify("live-gone", "vanishing", "");
    let info = listed(&bus).remove(0);
    let who = identity_of(&info);
    oracle(&["close", &id.to_string()]);
    let request = DismissNotificationRequest {
        index: info.index,
        app_filter: None,
        identity: &who,
        policy: InteractionPolicy::headed(),
    };
    let error = super::dismiss(&bus, request, &lease()).expect_err("gone");
    assert_eq!(
        error.code,
        agent_desktop_core::ErrorCode::NotificationNotFound
    );
}

fn monitor() -> (std::path::PathBuf, u32) {
    let root = std::env::var_os("AGENT_DESKTOP_PRIVATE_SESSION").expect("private session");
    let file =
        std::path::PathBuf::from(root).join(format!("live-monitor-{}.log", std::process::id()));
    let pid = oracle(&["monitor", file.to_str().expect("path")])
        .parse()
        .expect("monitor pid");
    std::thread::sleep(Duration::from_millis(800));
    (file, pid)
}

fn signals_seen(file: &std::path::Path, pid: u32) -> Vec<String> {
    std::thread::sleep(Duration::from_millis(800));
    Command::new("kill")
        .arg(pid.to_string())
        .status()
        .expect("stop the monitor");
    let log = std::fs::read_to_string(file).expect("monitor log");
    let lines: Vec<&str> = log.lines().collect();
    let mut seen = Vec::new();
    for (at, line) in lines.iter().enumerate() {
        let Some(member) = line.split("member=").nth(1) else {
            continue;
        };
        let arguments: Vec<&str> = lines[at + 1..]
            .iter()
            .take_while(|next| !next.starts_with("signal "))
            .map(|next| next.trim())
            .collect();
        seen.push(format!("{} {}", member.trim(), arguments.join(" ")));
    }
    seen
}

fn headed(bus: &SharedBus, title: &str) -> (usize, NotificationIdentity) {
    let info = listed(bus)
        .into_iter()
        .find(|info| info.title == title)
        .expect("listed");
    (info.index, identity_of(&info))
}

#[test]
#[ignore = "needs the private gnome-shell of scripts/notification-live.sh and an X11 pointer"]
fn dismiss_removes_exactly_the_target_and_the_daemon_reports_reason_two() {
    let bus = SharedBus::default();
    let (file, pid) = monitor();
    let keep = notify("live-keep", "keeper", "");
    let dropped = notify("live-drop", "dropped", "");
    let (index, who) = headed(&bus, "dropped");
    let request = DismissNotificationRequest {
        index,
        app_filter: None,
        identity: &who,
        policy: InteractionPolicy::headed(),
    };
    let done = super::dismiss(&bus, request, &lease()).expect("dismissed");
    assert_eq!(done.title, "dropped");
    let after = listed(&bus);
    assert!(after.iter().any(|info| info.title == "keeper"));
    assert!(!after.iter().any(|info| info.title == "dropped"));
    let seen = signals_seen(&file, pid);
    assert!(
        seen.iter()
            .any(|line| line == &format!("NotificationClosed uint32 {dropped} uint32 2")),
        "{seen:?}"
    );
    assert!(
        !seen
            .iter()
            .any(|line| line.contains(&format!("uint32 {keep} "))),
        "{seen:?}"
    );
    oracle(&["close", &keep.to_string()]);
}

#[test]
#[ignore = "needs the private gnome-shell of scripts/notification-live.sh and an X11 pointer"]
fn an_action_removes_the_entry_and_the_daemon_reports_the_action_key() {
    let bus = SharedBus::default();
    let (file, pid) = monitor();
    let id = notify("live-act", "actionable", "act1=Reply,act2=Archive");
    let (index, who) = headed(&bus, "actionable");
    let request = NotificationActionRequest {
        index,
        identity: &who,
        action_name: "Reply",
        policy: InteractionPolicy::headed(),
    };
    let result = super::action(&bus, request, &lease()).expect("delivered");
    assert_eq!(
        result.details.expect("details")["evidence"],
        "action_invoked"
    );
    assert!(!listed(&bus).iter().any(|info| info.title == "actionable"));
    let seen = signals_seen(&file, pid);
    assert!(
        seen.iter()
            .any(|line| line == &format!("ActionInvoked uint32 {id} string \"act1\"")),
        "{seen:?}"
    );
}

#[test]
#[ignore = "needs the private gnome-shell of scripts/notification-live.sh and an X11 pointer"]
fn dismiss_all_closes_each_entry_and_spares_other_apps() {
    let bus = SharedBus::default();
    let (file, pid) = monitor();
    let first = notify("live-c", "gamma", "");
    let other = notify("live-d", "delta", "");
    let second = notify("live-c", "epsilon", "");
    let scoped = DismissAllNotificationsRequest {
        app_filter: Some("live-c"),
        policy: InteractionPolicy::headed(),
    };
    let (dismissed, failures) = super::dismiss_all(&bus, scoped, &lease()).expect("scoped");
    assert_eq!(dismissed.len(), 2, "{failures:?}");
    assert!(failures.is_empty(), "{failures:?}");
    let left = listed(&bus);
    assert_eq!(left.len(), 1);
    assert_eq!(left[0].title, "delta");
    let everything = DismissAllNotificationsRequest {
        app_filter: None,
        policy: InteractionPolicy::headed(),
    };
    let (dismissed, failures) = super::dismiss_all(&bus, everything, &lease()).expect("all");
    assert_eq!(dismissed.len(), 1, "{failures:?}");
    assert!(listed(&bus).is_empty());
    let seen = signals_seen(&file, pid);
    for id in [first, second, other] {
        assert!(
            seen.iter()
                .any(|line| line == &format!("NotificationClosed uint32 {id} uint32 2")),
            "{id}: {seen:?}"
        );
    }
}
