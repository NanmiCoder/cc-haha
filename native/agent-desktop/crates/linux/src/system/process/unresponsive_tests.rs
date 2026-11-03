use super::{require_known_target, settle_matches, settle_scoped, stopped_target};
use crate::system::process::process_facts::ProcessFacts;
use crate::system::process::toolkit_id::ToolkitId;
use crate::system::registry::Registry;
use crate::system::registry::registry_app::{RegistryApp, assemble};
use crate::tree::AtspiElement;
use agent_desktop_core::{AppInfo, DeliverySemantics, ErrorCode};

fn app(pid: u32, exe: &str, answered: bool) -> RegistryApp {
    assemble(
        AtspiElement::new(":1.9", "/org/a11y/atspi/accessible/root", pid),
        ProcessFacts {
            executable: None,
            comm: exe.to_owned(),
            exe_basename: Some(exe.to_owned()),
            instance: "boot:1".to_owned(),
        },
        answered.then(|| Some("Name".to_owned())),
        ToolkitId::default(),
    )
}

fn registry(apps: Vec<RegistryApp>) -> Registry {
    Registry {
        apps,
        skipped: Vec::new(),
    }
}

#[test]
fn an_unanswering_stopped_target_is_app_unresponsive_naming_the_app() {
    let registry = registry(vec![app(7, "nautilus", false)]);
    let error = stopped_target(&registry, |_| true, |pid| pid == 7).expect("stopped");
    assert_eq!(error.code, ErrorCode::AppUnresponsive);
    assert!(error.message.contains("nautilus"));
}

#[test]
fn an_unanswering_app_that_is_not_stopped_is_not_reported() {
    let registry = registry(vec![app(7, "nautilus", false)]);
    assert!(stopped_target(&registry, |_| true, |_| false).is_none());
}

#[test]
fn a_stopped_looking_pid_of_an_answering_app_is_not_reported() {
    let registry = registry(vec![app(7, "gnome-calculator", true)]);
    assert!(stopped_target(&registry, |_| true, |_| true).is_none());
}

#[test]
fn only_the_selected_apps_are_considered() {
    let registry = registry(vec![
        app(7, "nautilus", false),
        app(8, "gnome-calculator", true),
    ]);
    assert!(stopped_target(&registry, |app| app.root.pid() == 8, |_| true).is_none());
    assert!(stopped_target(&registry, |app| app.root.pid() == 7, |_| true).is_some());
}

#[test]
fn an_unknown_name_is_app_not_found_suggesting_list_apps() {
    let registry = registry(vec![app(7, "nautilus", true)]);
    let error =
        require_known_target(&registry, |_| false, "Calculator", |_| None).expect_err("unknown");
    assert_eq!(error.code, ErrorCode::AppNotFound);
    assert!(error.message.contains("Calculator"));
    assert!(error.suggestion.expect("suggestion").contains("list-apps"));
}

#[test]
fn a_registered_app_without_windows_is_not_an_unknown_name() {
    let registry = registry(vec![app(7, "nautilus", true)]);
    let scanned = |_: &str| panic!("proc must not be scanned");
    assert!(require_known_target(&registry, |_| true, "nautilus", scanned).is_ok());
}

#[test]
fn a_bus_less_process_keeps_the_empty_list() {
    let registry = registry(Vec::new());
    let running = |_: &str| Some((77, "sleep".to_owned()));
    assert!(require_known_target(&registry, |_| true, "sleep", running).is_ok());
}

#[test]
fn a_stopped_twin_is_reported_even_when_its_same_name_twin_has_windows() {
    let registry = registry(vec![app(7, "chrome", false), app(8, "chrome", true)]);
    let stopped = stopped_target(&registry, |_| true, |pid| pid == 7);
    let error = settle_scoped(vec!["the running twin's window"], stopped).expect_err("stopped");
    assert_eq!(error.code, ErrorCode::AppUnresponsive);
    assert!(error.message.contains("chrome"));
}

#[test]
fn windows_are_returned_when_no_selected_app_is_stopped() {
    let kept = settle_scoped(vec![1, 2], None).expect("nothing is stopped");
    assert_eq!(kept, [1, 2]);
    assert!(
        settle_scoped(Vec::<u8>::new(), None)
            .expect("empty")
            .is_empty()
    );
}

fn listed(pid: u32) -> AppInfo {
    AppInfo {
        name: "chrome".to_owned(),
        pid: pid.into(),
        bundle_id: None,
        process_instance: Some("boot:1".to_owned()),
        presentation: None,
    }
}

#[test]
fn a_name_two_apps_share_is_unresponsive_when_one_of_them_is_stopped() {
    let registry = registry(vec![app(7, "chrome", false), app(8, "chrome", true)]);
    let error = settle_matches(vec![listed(7), listed(8)], || {
        stopped_target(&registry, |_| true, |pid| pid == 7)
    })
    .expect_err("a stopped twin");
    assert_eq!(error.code, ErrorCode::AppUnresponsive);
    assert!(error.message.contains("chrome"));
}

#[test]
fn a_name_two_running_apps_share_is_left_for_the_caller_to_call_ambiguous() {
    let kept = settle_matches(vec![listed(7), listed(8)], || None).expect("both run");
    assert_eq!(kept.len(), 2);
}

#[test]
fn a_single_stopped_match_is_returned_without_asking_what_is_stopped() {
    let kept = settle_matches(vec![listed(7)], || panic!("one match needs no twin check"))
        .expect("one match");
    assert_eq!(kept.len(), 1);
}

#[test]
fn an_unknown_target_is_refused_before_anything_is_sent() {
    let registry = registry(Vec::new());
    let error = require_known_target(&registry, |_| true, "zzz", |_| None).expect_err("unknown");
    assert_eq!(error.code, ErrorCode::AppNotFound);
    assert_eq!(error.disposition, DeliverySemantics::not_delivered());
}

struct ScopedRoot {
    stalled: bool,
}

#[zbus::interface(name = "org.a11y.atspi.Accessible")]
impl ScopedRoot {
    async fn get_children(&self) -> Vec<(String, zbus::zvariant::OwnedObjectPath)> {
        if self.stalled {
            std::future::pending::<()>().await;
        }
        Vec::new()
    }
}

#[test]
fn scoped_window_discovery_distinguishes_unanswered_children_from_an_observed_empty_root() {
    use agent_desktop_core::Deadline;
    use zbus::connection::Builder;

    for stalled in [false, true] {
        let (client, server) = std::os::unix::net::UnixStream::pair().unwrap();
        let (client, server) = zbus::block_on(futures_lite::future::zip(
            Builder::async_io_unix_stream(client).p2p().build(),
            Builder::async_io_unix_stream(server)
                .server(zbus::Guid::generate())
                .unwrap()
                .p2p()
                .serve_at("/root", ScopedRoot { stalled })
                .unwrap()
                .build(),
        ));
        let _server = server.unwrap();
        let bus = crate::system::bus::tests::connected(client.unwrap());
        let mut selected = app(std::process::id(), "fixture", true);
        selected.root = AtspiElement::new(":1.1", "/root", std::process::id());
        let registry = registry(vec![selected]);
        let result =
            super::scoped_windows_of(&bus, &registry, |_| true, Deadline::after(2_000).unwrap());
        if stalled {
            let error = result.expect_err("unanswered children cannot prove no surfaces");
            assert_eq!(error.code, ErrorCode::Timeout);
            assert_eq!(error.details.unwrap()["kind"], "frames_unanswered");
            assert_eq!(error.disposition, DeliverySemantics::not_delivered());
        } else {
            assert!(
                result
                    .expect("an observed empty root stays empty")
                    .is_empty()
            );
        }
    }
}
