use std::cell::Cell;
use std::collections::VecDeque;
use std::sync::Arc;
use std::sync::atomic::{AtomicUsize, Ordering};

use super::*;
use crate::system::window::native_group::{is_unproven, unproven};

fn this_process() -> Running {
    let facts = process_facts::read(std::process::id()).unwrap();
    Running {
        name: crate::system::app::app_name::app_name(&facts),
        pid: std::process::id(),
        instance: facts.instance,
        executable: facts.executable,
    }
}

fn window_of_owner(owner: &Running) -> WindowInfo {
    WindowInfo {
        id: "w-proven".to_owned(),
        title: String::new(),
        app: owner.name.clone(),
        pid: ProcessId::new(owner.pid),
        process_instance: Some(owner.instance.clone()),
        bounds: None,
        state: Default::default(),
    }
}

fn waiting_for_window<T>(timeout_ms: u64, body: impl FnOnce(&Launch<'_>, &Running) -> T) -> T {
    let deadline = Deadline::after(timeout_ms).unwrap();
    let options = LaunchOptions::default();
    let lease = InteractionLease::guarded(deadline, ()).unwrap();
    let bus = SharedBus::default();
    let launch = Launch {
        bus: &bus,
        id: "fixture",
        options: &options,
        lease: &lease,
        deadline,
    };
    body(&launch, &this_process())
}

struct Roots {
    children: Vec<(String, zbus::zvariant::OwnedObjectPath)>,
    names: Arc<AtomicUsize>,
}

#[zbus::interface(name = "org.a11y.atspi.Accessible")]
impl Roots {
    fn get_children(&self) -> Vec<(String, zbus::zvariant::OwnedObjectPath)> {
        self.children.clone()
    }

    #[zbus(property)]
    fn name(&self) -> String {
        self.names.fetch_add(1, Ordering::SeqCst);
        "fixture".into()
    }
}

struct Owners;

#[zbus::interface(name = "org.freedesktop.DBus")]
impl Owners {
    fn get_name_owner(&self, _name: &str) -> String {
        ":1.registry".into()
    }

    #[zbus(name = "GetConnectionUnixProcessID")]
    fn pid(&self, name: &str) -> u32 {
        if name == ":1.other" {
            unsafe { libc::getppid() as u32 }
        } else {
            std::process::id()
        }
    }
}

struct Events;

#[zbus::interface(name = "org.a11y.atspi.Registry")]
impl Events {
    fn register_event(&self, _event: &str, _properties: Vec<String>, _app: &str) {}
}

#[test]
fn launch_window_lookup_never_enriches_an_unrelated_process() {
    let unrelated = Arc::new(AtomicUsize::new(0));
    let target = Arc::new(AtomicUsize::new(0));
    let root = |children, names| Roots { children, names };
    let (client, server) = std::os::unix::net::UnixStream::pair().unwrap();
    let (client, server) = zbus::block_on(futures_lite::future::zip(
        zbus::connection::Builder::async_io_unix_stream(client)
            .p2p()
            .build(),
        zbus::connection::Builder::async_io_unix_stream(server)
            .server(zbus::Guid::generate())
            .unwrap()
            .p2p()
            .serve_at("/org/freedesktop/DBus", Owners)
            .unwrap()
            .serve_at("/org/a11y/atspi/registry", Events)
            .unwrap()
            .serve_at(
                crate::system::REGISTRY_ROOT_PATH,
                root(
                    vec![
                        (":1.target".into(), "/target".try_into().unwrap()),
                        (":1.other".into(), "/other".try_into().unwrap()),
                    ],
                    Arc::default(),
                ),
            )
            .unwrap()
            .serve_at("/target", root(Vec::new(), target.clone()))
            .unwrap()
            .serve_at("/other", root(Vec::new(), unrelated.clone()))
            .unwrap()
            .build(),
    ));
    let _server = server.unwrap();
    let bus = crate::system::bus::tests::connected(client.unwrap());
    let deadline = Deadline::after(5_000).unwrap();
    let owner = this_process();
    let options = LaunchOptions::default();
    let lease = InteractionLease::guarded(deadline, ()).unwrap();
    let launch = Launch {
        bus: &bus,
        id: "fixture",
        options: &options,
        lease: &lease,
        deadline,
    };
    assert!(
        launch
            .window_of(&owner, false, &HashSet::new())
            .unwrap()
            .is_none()
    );
    assert_eq!(unrelated.load(Ordering::SeqCst), 0);
    assert!(target.load(Ordering::SeqCst) > 0, "the owner was enriched");
}

#[test]
fn a_window_read_the_display_could_not_prove_is_read_again_and_the_window_is_reported() {
    let calls = Cell::new(0);
    let found = waiting_for_window(5_000, |launch, owner| {
        let mut reads =
            VecDeque::from([Err(unproven(owner.pid)), Ok(vec![window_of_owner(owner)])]);
        launch
            .wait_for_window(owner, true, &HashSet::new(), || {
                calls.set(calls.get() + 1);
                reads.pop_front().expect("no read after the window")
            })
            .expect("a refused read does not end the launch")
    });
    assert_eq!(found.expect("the proven window").id, "w-proven");
    assert_eq!(calls.get(), 2);
}

#[test]
fn a_window_never_proven_ends_in_its_refusal_with_the_report_of_how_far_the_launch_went() {
    for (started, delivery) in [
        (true, DeliverySemantics::delivered_unverified()),
        (false, DeliverySemantics::not_delivered()),
    ] {
        let calls = Cell::new(0);
        let error = waiting_for_window(300, |launch, owner| {
            launch
                .wait_for_window(owner, started, &HashSet::new(), || {
                    calls.set(calls.get() + 1);
                    Err(unproven(owner.pid))
                })
                .expect_err("no window was proven before the deadline")
        });
        assert!(is_unproven(&error), "started {started}: {error:?}");
        assert_eq!(error.disposition, delivery, "started {started}");
        assert!(error.suggestion.is_some(), "started {started}");
        assert!(calls.get() > 1, "started {started}: {} reads", calls.get());
    }
}

#[test]
fn any_other_refusal_of_the_window_read_still_ends_the_launch_at_once() {
    let calls = Cell::new(0);
    let error = waiting_for_window(5_000, |launch, owner| {
        launch
            .wait_for_window(owner, true, &HashSet::new(), || {
                calls.set(calls.get() + 1);
                Err(AdapterError::new(
                    ErrorCode::ActionNotSupported,
                    "another refusal",
                ))
            })
            .expect_err("an unrelated refusal ends the wait")
    });
    assert_eq!(calls.get(), 1);
    assert!(!is_unproven(&error));
    assert_eq!(error.disposition, DeliverySemantics::delivered_unverified());
}
