use agent_desktop_core::{ErrorCode, RefEntry};

use super::*;
use crate::system::process::process_facts::ProcessFacts;
use crate::system::process::process_lookup::Lookup;
use crate::system::{NAME_HAS_NO_OWNER, window::window_id};
use crate::tree::live::test_support::{client_timeout, method_error, ref_entry};

fn entry() -> RefEntry {
    let mut entry = ref_entry("button");
    entry.process.pid = 40.into();
    entry.process.process_instance = Some("boot:100".to_owned());
    entry.source.source_window_id = window_id::encode(":1.2", "/org/a11y/atspi/accessible/1");
    entry
}

fn running(instance: &str) -> Lookup {
    Lookup::Found(ProcessFacts {
        executable: None,
        comm: "app".to_owned(),
        exe_basename: None,
        instance: instance.to_owned(),
    })
}

fn kind(error: &AdapterError) -> &str {
    error
        .details
        .as_ref()
        .and_then(|details| details.get("kind"))
        .and_then(serde_json::Value::as_str)
        .unwrap_or_default()
}

fn window() -> StoredWindow {
    stored_window(&entry()).expect("a complete entry names its window")
}

#[test]
fn a_ref_that_names_no_window_or_one_this_adapter_did_not_issue_is_refused() {
    let mut without_id = entry();
    without_id.source.source_window_id = None;
    let mut foreign = entry();
    foreign.source.source_window_id = Some("w-12345".to_owned());
    for refused in [without_id, foreign] {
        let error = stored_window(&refused).expect_err("refused");
        assert_eq!(error.code, ErrorCode::StaleRef);
        assert_eq!(kind(&error), "resolve_window_unverifiable");
    }
}

#[test]
fn a_ref_without_a_process_instance_token_is_refused_even_when_the_window_id_is_good() {
    for missing in [None, Some(String::new())] {
        let mut bare = entry();
        bare.process.process_instance = missing;
        let error = stored_window(&bare).expect_err("refused");
        assert_eq!(kind(&error), "resolve_window_unverifiable");
    }
}

#[test]
fn the_frame_is_the_stored_address_and_its_own_frame() {
    let frame = window().frame();
    assert_eq!(frame.bus_name(), ":1.2");
    assert_eq!(frame.path(), "/org/a11y/atspi/accessible/1");
    assert_eq!(frame.pid(), 40);
    assert_eq!(frame.frame(), Some(&frame.address()));
    assert!(!frame.in_web_document());
}

#[test]
fn a_process_with_another_start_time_is_a_different_process() {
    assert!(
        window()
            .check_process(&running("boot:100"), &entry())
            .is_ok()
    );
    let replaced = window()
        .check_process(&running("boot:101"), &entry())
        .expect_err("another start time");
    assert_eq!(replaced.code, ErrorCode::StaleRef);
    assert_eq!(kind(&replaced), "resolve_window_replaced");
}

#[test]
fn a_pid_with_no_process_has_exited() {
    let exited = window()
        .check_process(&Lookup::Gone, &entry())
        .expect_err("no process");
    assert_eq!(kind(&exited), "resolve_owning_process_exited");
}

#[test]
fn a_pid_that_could_not_be_read_is_retried_and_never_declared_exited() {
    let unread = window()
        .check_process(&Lookup::Unreadable, &entry())
        .expect_err("unidentified");
    assert_eq!(unread.code, ErrorCode::Timeout);
    assert!(unread.is_explicitly_retryable());
    assert_ne!(kind(&unread), "resolve_owning_process_exited");
}

#[test]
fn an_owner_with_another_pid_is_a_different_process() {
    assert!(window().check_owner(Ok(40), &entry()).is_ok());
    let replaced = window()
        .check_owner(Ok(41), &entry())
        .expect_err("another owner");
    assert_eq!(kind(&replaced), "resolve_window_replaced");
}

#[test]
fn a_missing_bus_owner_is_only_exited_when_its_process_is_gone() {
    for (pid, expected) in [
        (std::process::id(), "resolve_owner_unreachable"),
        (u32::MAX, "resolve_owning_process_exited"),
    ] {
        let mut entry = entry();
        entry.process.pid = pid.into();
        let error = stored_window(&entry)
            .expect("stored window")
            .check_owner(Err(method_error(NAME_HAS_NO_OWNER)), &entry)
            .expect_err("no owner");
        assert_eq!(kind(&error), expected);
        assert_eq!(error.code, ErrorCode::StaleRef);
        assert!(!error.is_explicitly_retryable());
    }
}

#[test]
fn an_owner_the_bus_cannot_identify_is_retryable_never_a_match() {
    let slow = window()
        .check_owner(Err(client_timeout()), &entry())
        .expect_err("slow");
    assert_eq!(slow.code, ErrorCode::Timeout);

    let unnamed = window()
        .check_owner(Err(method_error("org.example.Error.Unheard")), &entry())
        .expect_err("unnamed");
    assert_eq!(unnamed.code, ErrorCode::Timeout);
    assert!(unnamed.is_explicitly_retryable());
}
