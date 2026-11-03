use agent_desktop_core::{ErrorCode, ProcessIdentity};

use super::{judge_frame, judge_owner};
use crate::system::process::process_facts::ProcessFacts;
use crate::system::process::process_lookup::Lookup;

fn facts(instance: &str) -> Lookup {
    Lookup::Found(ProcessFacts {
        executable: None,
        comm: "app".to_owned(),
        exe_basename: None,
        instance: instance.to_owned(),
    })
}

fn expected() -> ProcessIdentity {
    ProcessIdentity::new(1000u32, "boot:77")
}

#[test]
fn a_frame_of_the_expected_process_instance_passes() {
    assert!(judge_frame(&expected(), 1000, &facts("boot:77")).is_ok());
}

#[test]
fn a_frame_with_another_pid_is_stale() {
    let error = judge_frame(&expected(), 1001, &facts("boot:77")).expect_err("pid differs");
    assert_eq!(error.code, ErrorCode::StaleRef);
}

#[test]
fn a_restarted_or_gone_process_is_stale() {
    for live in [facts("boot:78"), Lookup::Gone] {
        let error = judge_frame(&expected(), 1000, &live).expect_err("not the same process");
        assert_eq!(error.code, ErrorCode::StaleRef);
    }
}

#[test]
fn an_unreadable_process_is_retried_and_never_declared_stale() {
    let error = judge_frame(&expected(), 1000, &Lookup::Unreadable).expect_err("unidentified");
    assert_eq!(error.code, ErrorCode::ActionFailed);
}

#[test]
fn a_target_bus_name_owned_by_its_recorded_pid_passes_whatever_the_window_pid() {
    assert!(judge_owner(4242, Ok(4242)).is_ok());
}

#[test]
fn a_bus_name_re_owned_by_another_pid_is_stale() {
    let error = judge_owner(4242, Ok(4243)).expect_err("owner differs");
    assert_eq!(error.code, ErrorCode::StaleRef);
}

#[test]
fn a_name_nobody_owns_is_stale() {
    let error = judge_owner(4242, Err(None)).expect_err("name left the bus");
    assert_eq!(error.code, ErrorCode::StaleRef);
}
