use std::future::Future;

use agent_desktop_core::{AdapterError, Deadline, ErrorCode, LocatorEvidence, RefEntry};
use futures_util::StreamExt;
use zbus::connection::Builder;
use zbus::zvariant::OwnedObjectPath;

use super::BusSource;
use crate::system::{SharedBus, process::process_facts, window::window_id, within};
use crate::tree::AtspiElement;
use crate::tree::resolve::searched::Searched;
use crate::tree::resolve::{Source, resolve};
use crate::tree::walk::level::Level;

struct FrameService {
    role: u32,
    children: Vec<(String, OwnedObjectPath)>,
}

#[zbus::interface(name = "org.a11y.atspi.Accessible")]
impl FrameService {
    fn get_role(&self) -> u32 {
        self.role
    }

    fn get_children(&self) -> Vec<(String, OwnedObjectPath)> {
        self.children.clone()
    }
}

struct DepartingRenderer<'a> {
    source: BusSource<'a>,
    renderer: Option<zbus::Connection>,
}

impl Source for DepartingRenderer<'_> {
    fn open_window(&mut self, entry: &RefEntry) -> Result<AtspiElement, AdapterError> {
        self.source.open_window(entry)
    }

    fn level(&mut self, element: &AtspiElement) -> Result<Level<AtspiElement>, AdapterError> {
        let level = self.source.level(element)?;
        if let Some(renderer) = self.renderer.take() {
            let name = renderer
                .unique_name()
                .expect("unique renderer owner")
                .to_string();
            let connection = self.source.connection.clone();
            within(deadline(), async {
                let proxy = zbus::fdo::DBusProxy::new(&connection)
                    .await
                    .expect("bus oracle");
                let mut changes = proxy
                    .receive_name_owner_changed_with_args(&[(0, name.as_str())])
                    .await
                    .expect("departure subscription");
                renderer
                    .close()
                    .await
                    .expect("disconnect only the owned renderer");
                let change = changes
                    .next()
                    .await
                    .expect("bus confirms renderer departure");
                assert!(change.args().expect("owner change").new_owner().is_none());
                Ok(())
            })?;
        }
        Ok(level)
    }

    fn evidence(&mut self, element: &AtspiElement) -> Result<LocatorEvidence, AdapterError> {
        self.source.evidence(element)
    }

    fn search(&mut self, frame: &AtspiElement, entry: &RefEntry) -> Result<Searched, AdapterError> {
        self.source.search(frame, entry)
    }

    fn stopped_app(&mut self, pid: u32) -> Option<String> {
        self.source.stopped_app(pid)
    }
}

fn deadline() -> Deadline {
    Deadline::after(5_000).expect("deadline")
}

fn fixture_request<T>(label: &str, future: impl Future<Output = Result<T, zbus::Error>>) -> T {
    println!("private fixture: {label}");
    within(deadline(), async {
        future
            .await
            .map_err(|error| AdapterError::internal(error.to_string()))
    })
    .expect(label)
}

#[test]
#[ignore = "real accessibility owners; run inside scripts/private-session.sh --wm"]
fn live_renderer_bus_departure_keeps_the_answering_frame_owner_alive() {
    std::env::var("AGENT_DESKTOP_PRIVATE_SESSION").expect("private session");
    let session = fixture_request("session bus ready", zbus::Connection::session());
    let address: String = fixture_request(
        "accessibility bus ready",
        session.call_method(
            Some("org.a11y.Bus"),
            "/org/a11y/bus",
            Some("org.a11y.Bus"),
            "GetAddress",
            &(),
        ),
    )
    .body()
    .deserialize()
    .expect("bus address");
    let renderer = fixture_request(
        "renderer services ready",
        Builder::address(address.as_str())
            .expect("address")
            .name("org.agentdesktop.RendererFixture")
            .expect("private renderer name")
            .serve_at(
                "/renderer",
                FrameService {
                    role: crate::tree::vocabulary::role_numbers::PANEL,
                    children: vec![(
                        "org.agentdesktop.RendererFixture".to_owned(),
                        "/target".try_into().expect("target path"),
                    )],
                },
            )
            .expect("renderer service")
            .serve_at(
                "/target",
                FrameService {
                    role: crate::tree::vocabulary::role_numbers::PUSH_BUTTON,
                    children: Vec::new(),
                },
            )
            .expect("target service")
            .build(),
    );
    let renderer_name = renderer
        .unique_name()
        .expect("unique renderer owner")
        .to_string();
    let oracle = fixture_request(
        "independent oracle ready",
        Builder::address(address.as_str()).expect("address").build(),
    );
    let target_role = fixture_request(
        "target answers before departure",
        oracle.call_method(
            Some(renderer_name.as_str()),
            "/target",
            Some("org.a11y.atspi.Accessible"),
            "GetRole",
            &(),
        ),
    );
    assert_eq!(
        target_role
            .body()
            .deserialize::<u32>()
            .expect("target role"),
        crate::tree::vocabulary::role_numbers::PUSH_BUTTON
    );
    let frame = fixture_request(
        "frame service ready",
        Builder::address(address.as_str())
            .expect("address")
            .serve_at(
                "/frame",
                FrameService {
                    role: crate::tree::vocabulary::role_numbers::FRAME,
                    children: vec![(
                        renderer_name.clone(),
                        "/renderer".try_into().expect("renderer path"),
                    )],
                },
            )
            .expect("frame service")
            .build(),
    );
    let frame_name = frame.unique_name().expect("unique frame owner").as_str();
    let pid = std::process::id();
    let mut entry = crate::tree::live::test_support::ref_entry("button");
    entry.identity.name = Some("Target".to_owned());
    entry.process.pid = pid.into();
    entry.process.process_instance = Some(
        process_facts::read(pid)
            .expect("live frame process")
            .instance,
    );
    entry.source.source_window_id = window_id::encode(frame_name, "/frame");
    entry.scope.path = [0, 0].into_iter().collect();
    let bus = SharedBus::default();
    let mut source = DepartingRenderer {
        source: BusSource::open(&bus, deadline()).expect("live bus source"),
        renderer: Some(renderer),
    };
    let error = resolve(&mut source, &entry, deadline()).expect_err("renderer left during descent");
    assert_eq!(error.code, ErrorCode::StaleRef);
    let details = error.details.as_ref().expect("departure cause");
    assert_eq!(details["kind"], "resolve_descendant_owner_gone");
    assert_eq!(details["failed_bus"], renderer_name);
    assert_eq!(details["complete"], false);
    assert!(error.is_explicitly_retryable());
    let reply = fixture_request(
        "frame still answers after refusal",
        oracle.call_method(
            Some(frame_name),
            "/frame",
            Some("org.a11y.atspi.Accessible"),
            "GetRole",
            &(),
        ),
    );
    assert_eq!(
        reply.body().deserialize::<u32>().expect("frame role"),
        crate::tree::vocabulary::role_numbers::FRAME
    );
    println!("live proof: {error:?}; stored frame still answers GetRole");
}
