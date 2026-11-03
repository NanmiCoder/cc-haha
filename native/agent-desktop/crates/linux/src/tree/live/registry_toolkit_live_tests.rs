use agent_desktop_core::Deadline;

use super::live_apps::{qt, terminal};
use super::live_rig::rig;
use crate::LinuxAdapter;
use crate::system::registry::toolkit;
use crate::system::{REGISTRY_ROOT_PATH, SharedBus, within};
use crate::tree::AtspiElement;
use crate::tree::properties::toolkit_trust::{ToolkitKind, kind};

fn registry_kind(bus: &SharedBus, frame: &AtspiElement) -> Result<ToolkitKind, String> {
    let deadline = Deadline::standard().map_err(|error| error.message)?;
    let connection = bus.get(deadline).map_err(|error| error.message)?;
    let root = AtspiElement::new(frame.bus_name(), REGISTRY_ROOT_PATH, frame.pid());
    let id = within(deadline, async {
        Ok(toolkit(connection.inner(), &root).await)
    })
    .map_err(|error| error.message)?;
    Ok(kind(&id))
}

fn expect_kind(
    wanted: ToolkitKind,
) -> impl Fn(&str, &LinuxAdapter, &SharedBus, &AtspiElement) -> Result<(), String> {
    move |label, _, bus, frame| {
        let found = registry_kind(bus, frame)?;
        if found == wanted {
            Ok(())
        } else {
            Err(format!(
                "[{label}] registry toolkit read {found:?}, wanted {wanted:?}"
            ))
        }
    }
}

#[test]
#[ignore = "drives a real desktop application; run through scripts/private-session.sh"]
fn registry_toolkit_live_reads_gtk3_and_qt_that_refuse_the_group_read() {
    let session = rig();
    terminal(
        &session.adapter,
        &session.bus,
        |label, adapter, bus, frame| expect_kind(ToolkitKind::Gtk3)(label, adapter, bus, frame),
    )
    .expect("gtk3 terminal");
    qt(
        &session.adapter,
        &session.bus,
        |label, adapter, bus, frame| expect_kind(ToolkitKind::Qt)(label, adapter, bus, frame),
    )
    .expect("qt");
}

struct ReportedToolkit {
    name: String,
}

#[zbus::interface(name = "org.a11y.atspi.Application")]
impl ReportedToolkit {
    #[zbus(property)]
    fn toolkit_name(&self) -> &str {
        &self.name
    }

    #[zbus(property)]
    fn version(&self) -> &str {
        "1.0"
    }
}

#[test]
#[ignore = "owned accessibility service; run through scripts/private-session.sh"]
fn web_family_live_follows_application_metadata_in_an_unrelated_process() {
    use crate::system::process::web_family::WebFamily;
    use crate::tree::properties::toolkit_trust::read_web_family;

    std::env::var_os("AGENT_DESKTOP_PRIVATE_SESSION").expect("private session");
    let session = zbus::blocking::Connection::session().expect("session bus");
    let address: String = session
        .call_method(
            Some("org.a11y.Bus"),
            "/org/a11y/bus",
            Some("org.a11y.Bus"),
            "GetAddress",
            &(),
        )
        .expect("accessibility address")
        .body()
        .deserialize()
        .expect("address");
    let bus = SharedBus::default();
    let deadline = Deadline::after(10_000).expect("deadline");
    let connection = bus.get(deadline).expect("accessibility bus");
    for (name, expected) in [
        ("Chromium", Some(WebFamily::Chromium)),
        ("gEcKo", Some(WebFamily::Gecko)),
        ("gtk", None),
        ("firefox", None),
    ] {
        let service = zbus::block_on(
            zbus::connection::Builder::address(address.as_str())
                .expect("address")
                .serve_at(
                    REGISTRY_ROOT_PATH,
                    ReportedToolkit {
                        name: name.to_owned(),
                    },
                )
                .expect("application interface")
                .build(),
        )
        .expect("owned metadata service");
        let root = AtspiElement::new(
            service.unique_name().expect("unique name").as_str(),
            REGISTRY_ROOT_PATH,
            std::process::id(),
        );
        let found =
            within(deadline, read_web_family(connection.inner(), &root)).expect("metadata read");
        assert_eq!(found, expected, "reported toolkit {name}");
    }
}
