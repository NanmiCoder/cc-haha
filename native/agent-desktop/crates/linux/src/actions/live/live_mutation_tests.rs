use std::sync::{Arc, Mutex};

use agent_desktop_core::{Deadline, DeliverySemantics, ErrorCode, InteractionPolicy};
use zbus::zvariant::OwnedObjectPath;

use crate::actions::context::Target;
use crate::system::{SharedBus, within};
use crate::tree::vocabulary::state_bits::{
    ENABLED, READ_ONLY, SELECTED, SENSITIVE, SHOWING, VISIBLE,
};
use crate::tree::{AtspiElement, element::ancestry};

#[derive(Default)]
struct State {
    value: f64,
    writes: usize,
    selects: usize,
    selected: i32,
    replacement: &'static str,
}

type Shared = Arc<Mutex<State>>;

struct Accessible {
    role: u32,
    read_only: bool,
    row: bool,
    owner: String,
    state: Shared,
}

#[zbus::interface(name = "org.a11y.atspi.Accessible")]
impl Accessible {
    fn get_role(&self) -> u32 {
        self.role
    }
    fn get_state(&self) -> Vec<u32> {
        let mut words = vec![0u32; 2];
        for bit in [ENABLED, SENSITIVE, SHOWING, VISIBLE] {
            words[bit as usize / 32] |= 1 << (bit % 32);
        }
        if self.read_only {
            words[READ_ONLY as usize / 32] |= 1 << (READ_ONLY % 32);
        }
        let selected = self.state.lock().unwrap().selected;
        if self.role == 32 && (selected == 2 || (self.row && selected == 1)) {
            words[SELECTED as usize / 32] |= 1 << (SELECTED % 32);
        }
        words
    }
    fn get_interfaces(&self) -> Vec<&str> {
        let mut names = vec!["org.a11y.atspi.Accessible"];
        if self.role == 51 {
            names.push("org.a11y.atspi.Value");
        }
        if self.role == 31 {
            names.push("org.a11y.atspi.Selection");
        }
        names
    }
    fn get_children(&self) -> Vec<(String, OwnedObjectPath)> {
        if self.role == 31 {
            vec![
                (self.owner.clone(), "/row".try_into().unwrap()),
                (self.owner.clone(), "/extra".try_into().unwrap()),
            ]
        } else {
            vec![]
        }
    }
    fn get_index_in_parent(&self) -> i32 {
        i32::from(self.role == 32 && !self.row)
    }
    fn get_child_at_index(&self, index: i32) -> (String, OwnedObjectPath) {
        let state = self.state.lock().unwrap();
        let reordered = state.replacement == "stale" && state.selected == 0 && state.selects > 0;
        let path = if index == 1 || reordered {
            "/extra"
        } else {
            "/row"
        };
        (self.owner.clone(), path.try_into().unwrap())
    }
    #[zbus(property)]
    fn name(&self) -> &str {
        if self.row { "wanted" } else { "control" }
    }
    #[zbus(property)]
    fn description(&self) -> &str {
        ""
    }
    #[zbus(property)]
    fn child_count(&self) -> i32 {
        if self.role == 31 { 2 } else { 0 }
    }
}

struct Numeric(Shared);

#[zbus::interface(name = "org.a11y.atspi.Value")]
impl Numeric {
    #[zbus(property)]
    fn current_value(&self) -> f64 {
        self.0.lock().unwrap().value
    }
    #[zbus(property)]
    fn set_current_value(&self, value: f64) {
        let mut state = self.0.lock().unwrap();
        state.writes += 1;
        state.value = value;
    }
}

struct Selection(Shared);

#[zbus::interface(name = "org.a11y.atspi.Selection")]
impl Selection {
    fn select_child(&self, _index: i32) -> zbus::fdo::Result<bool> {
        let mut state = self.0.lock().unwrap();
        state.selects += 1;
        if state.selects > 1 {
            match state.replacement {
                "denied" => {
                    return Err(zbus::fdo::Error::AccessDenied(
                        "replacement refused".to_owned(),
                    ));
                }
                "absent" => return Ok(false),
                _ => {}
            }
        }
        state.selected = if state.selects == 1 { 2 } else { 1 };
        Ok(true)
    }
    fn clear_selection(&self) -> bool {
        self.0.lock().unwrap().selected = 0;
        true
    }
    #[zbus(property)]
    fn n_selected_children(&self) -> i32 {
        self.0.lock().unwrap().selected
    }
}

struct Application;

#[zbus::interface(name = "org.a11y.atspi.Application")]
impl Application {
    #[zbus(property)]
    fn toolkit_name(&self) -> &str {
        "gtk"
    }
    #[zbus(property)]
    fn version(&self) -> &str {
        "3.0"
    }
}

fn deadline() -> Deadline {
    Deadline::after(10_000).unwrap()
}

fn element(owner: &str, path: &str) -> AtspiElement {
    let mut element = AtspiElement::new(owner, path, std::process::id());
    element.set_ancestry(ancestry::of_root(&element));
    element
}

fn install(bus: &SharedBus, state: &Shared, read_only: bool) -> String {
    assert!(std::env::var_os("AGENT_DESKTOP_PRIVATE_SESSION").is_some());
    let connection = bus.get(deadline()).unwrap();
    let owner = connection.unique_name().unwrap().to_string();
    within(deadline(), async {
        let server = connection.inner().object_server();
        for (path, role, row) in [
            ("/number", 51, false),
            ("/list", 31, false),
            ("/row", 32, true),
            ("/extra", 32, false),
        ] {
            server
                .at(
                    path,
                    Accessible {
                        role,
                        read_only,
                        row,
                        owner: owner.clone(),
                        state: state.clone(),
                    },
                )
                .await
                .unwrap();
        }
        server.at("/number", Numeric(state.clone())).await.unwrap();
        server.at("/list", Selection(state.clone())).await.unwrap();
        server
            .at(crate::system::REGISTRY_ROOT_PATH, Application)
            .await
            .unwrap();
        Ok(())
    })
    .unwrap();
    owner
}

#[test]
#[ignore = "private AT-SPI fixture; run through scripts/private-session.sh --wm"]
fn numeric_read_only_is_refused_before_set_without_requiring_editable() {
    for read_only in [true, false] {
        let bus = SharedBus::default();
        let state = Shared::default();
        let owner = install(&bus, &state, read_only);
        let element = element(&owner, "/number");
        let handle = element.clone().into_native_handle();
        let target = Target {
            bus: &bus,
            handle: &handle,
            element: &element,
            deadline: deadline(),
        };
        let outcome = crate::actions::write::value_write::set_value(
            &target,
            "7",
            InteractionPolicy::headless(),
        );
        if read_only {
            let error = outcome.expect_err("explicit read-only control");
            assert_eq!(error.code, ErrorCode::ActionNotSupported);
            assert_eq!(error.disposition, DeliverySemantics::not_delivered());
            assert_eq!(state.lock().unwrap().writes, 0);
        } else {
            outcome.expect("numeric controls do not need EDITABLE");
            let state = state.lock().unwrap();
            assert_eq!(state.writes, 1);
            assert_eq!(state.value, 7.0);
        }
    }
}

#[test]
#[ignore = "private AT-SPI fixture; run through scripts/private-session.sh --wm"]
fn a_selection_failure_after_clear_is_returned_with_partial_delivery() {
    for replacement in ["denied", "absent", "stale", "done"] {
        let bus = SharedBus::default();
        let state = Shared::new(Mutex::new(State {
            replacement,
            ..State::default()
        }));
        let owner = install(&bus, &state, false);
        let element = element(&owner, "/list");
        let handle = element.clone().into_native_handle();
        let target = Target {
            bus: &bus,
            handle: &handle,
            element: &element,
            deadline: deadline(),
        };
        let outcome = crate::actions::select::select(&target, "wanted", None);
        if replacement != "done" {
            let error = outcome.expect_err("clear succeeded and replacement failed");
            let (code, disposition) = match replacement {
                "denied" => (ErrorCode::PermDenied, DeliverySemantics::uncertain()),
                "stale" => (ErrorCode::StaleRef, DeliverySemantics::uncertain()),
                _ => (
                    ErrorCode::ActionFailed,
                    DeliverySemantics::delivered_unverified(),
                ),
            };
            assert_eq!(error.code, code);
            assert_eq!(error.disposition, disposition);
            assert_eq!(state.lock().unwrap().selected, 0);
        } else {
            outcome.expect("exclusive selection succeeds");
            assert_eq!(state.lock().unwrap().selected, 1);
        }
        assert_eq!(
            state.lock().unwrap().selects,
            if replacement == "stale" { 1 } else { 2 }
        );
    }
}

struct ScrollComponent(&'static str);

#[zbus::interface(name = "org.a11y.atspi.Component")]
impl ScrollComponent {
    fn scroll_to(&self, _position: u32) -> zbus::fdo::Result<bool> {
        match self.0 {
            "denied" => Err(zbus::fdo::Error::AccessDenied("denied".to_owned())),
            "no_reply" => Err(zbus::fdo::Error::NoReply("unknown outcome".to_owned())),
            "absent" => Err(zbus::fdo::Error::NotSupported("no scroll".to_owned())),
            _ => Ok(true),
        }
    }
}

#[test]
#[ignore = "private AT-SPI fixture; run through scripts/private-session.sh --wm"]
fn scroll_to_only_falls_through_for_a_proven_absent_affordance() {
    use crate::actions::scroll::scroll_into_view::ScrollPort;
    for (mode, expected) in [
        (
            "denied",
            Some((ErrorCode::PermDenied, DeliverySemantics::not_delivered())),
        ),
        (
            "no_reply",
            Some((ErrorCode::Timeout, DeliverySemantics::uncertain())),
        ),
        ("absent", None),
        ("done", None),
    ] {
        let bus = SharedBus::default();
        let connection = bus.get(deadline()).unwrap();
        zbus::block_on(
            connection
                .inner()
                .object_server()
                .at("/scroll", ScrollComponent(mode)),
        )
        .unwrap();
        let element = element(connection.unique_name().unwrap().as_str(), "/scroll");
        let handle = element.clone().into_native_handle();
        let mut port =
            crate::actions::scroll::scroll_bus::BusPort::new(&bus, &handle, &element, deadline());
        let outcome = port.scroll_to();
        match expected {
            Some((code, disposition)) => {
                let error = outcome.expect_err(mode);
                assert_eq!(error.code, code);
                assert_eq!(error.disposition, disposition);
            }
            None => assert_eq!(outcome.unwrap(), mode == "done"),
        }
    }
}
