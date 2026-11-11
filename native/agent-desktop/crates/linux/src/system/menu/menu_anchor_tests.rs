use super::{owned_by, settle, targets};
use crate::system::process::process_facts::ProcessFacts;
use crate::system::process::toolkit_id::ToolkitId;
use crate::system::registry::registry_app::{RegistryApp, assemble};
use crate::tree::AtspiElement;
fn app_at(bus: &str, path: &str, pid: u32) -> RegistryApp {
    assemble(
        AtspiElement::new(bus, path, pid),
        ProcessFacts {
            executable: None,
            comm: "x".to_owned(),
            exe_basename: Some("x".to_owned()),
            instance: "boot:1".to_owned(),
        },
        Some(Some("App".to_owned())),
        ToolkitId::default(),
    )
}

fn app(pid: u32) -> RegistryApp {
    app_at(":1.9", "/org/a11y/atspi/accessible/root", pid)
}

fn root() -> AtspiElement {
    AtspiElement::new(":1.9", "/org/a11y/atspi/accessible/root", 7)
}

#[test]
fn an_unrelated_process_is_not_selected_and_a_second_entry_of_the_target_is() {
    let select = owned_by(7);
    assert!(select(&app(7)));
    assert!(select(&app_at(":1.10", "/other/root", 7)));
    assert!(!select(&app(8)));
    assert!(!select(&app_at(":1.9", "/other/root", 8)));
}

#[test]
fn a_process_with_no_window_is_read_from_its_roots() {
    let found = targets(vec![root()], Vec::new()).expect("root targets do not need decoding");
    assert_eq!(found.len(), 1);
    assert_eq!(found[0].bus_name(), ":1.9");
    assert_eq!(found[0].path(), "/org/a11y/atspi/accessible/root");
    assert_eq!(found[0].pid(), 7);
}

#[test]
fn a_closed_answer_needs_a_whole_read() {
    assert_eq!(settle(false).ok(), Some(false));
    let error = settle(true).expect_err("a partial read cannot say closed");
    assert_eq!(error.code, agent_desktop_core::ErrorCode::Timeout);
}
