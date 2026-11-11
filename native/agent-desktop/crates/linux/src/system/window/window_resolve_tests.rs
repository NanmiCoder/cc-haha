use agent_desktop_core::{ErrorCode, WindowInfo, WindowState};

use super::{Liveness, verify};

fn window(id: &str, pid: u32, instance: Option<&str>, title: &str) -> WindowInfo {
    WindowInfo {
        id: id.to_owned(),
        title: title.to_owned(),
        app: "a".to_owned(),
        pid: pid.into(),
        process_instance: instance.map(str::to_owned),
        bounds: None,
        state: WindowState::default(),
    }
}

#[test]
fn a_live_window_with_the_same_process_resolves_even_when_retitled() {
    let stored = window("w-1.2-a", 5, Some("b:1"), "Old title");
    let live = vec![window("w-1.2-a", 5, Some("b:1"), "New title")];
    assert_eq!(
        verify(&stored, live, Liveness::Alive)
            .expect("resolves")
            .title,
        "New title"
    );
}

#[test]
fn a_different_pid_is_window_not_found() {
    let stored = window("w-1.2-a", 5, Some("b:1"), "t");
    let live = vec![window("w-1.2-a", 6, Some("b:1"), "t")];
    assert_eq!(
        verify(&stored, live, Liveness::Alive)
            .expect_err("refused")
            .code,
        ErrorCode::WindowNotFound
    );
}

#[test]
fn a_stored_window_without_a_process_instance_is_refused() {
    let stored = window("w-1.2-a", 5, None, "t");
    let live = vec![window("w-1.2-a", 5, Some("b:1"), "t")];
    assert_eq!(
        verify(&stored, live, Liveness::Alive)
            .expect_err("refused")
            .code,
        ErrorCode::StaleRef
    );
}

#[test]
fn a_stopped_process_is_unresponsive_with_or_without_a_listed_window() {
    let stored = window("w-1.2-a", 5, Some("b:1"), "t");
    for live in [Vec::new(), vec![stored.clone()]] {
        let error = verify(&stored, live, Liveness::Stopped).expect_err("stopped");
        assert_eq!(error.code, ErrorCode::AppUnresponsive);
        assert!(error.message.contains("'a'"));
    }
}

#[test]
fn an_absent_window_of_a_gone_process_is_window_not_found() {
    let stored = window("w-1.2-a", 5, Some("b:1"), "t");
    let error = verify(&stored, Vec::new(), Liveness::Gone).expect_err("gone");
    assert_eq!(error.code, ErrorCode::WindowNotFound);
    assert!(error.message.contains("no longer open"));
}

#[test]
fn a_reused_process_id_keeps_the_different_process_refusal_while_the_process_answers() {
    let stored = window("w-1.2-a", 5, Some("b:1"), "t");
    for process in [Liveness::Alive, Liveness::Gone] {
        let live = vec![window("w-1.2-a", 5, Some("b:2"), "t")];
        let error = verify(&stored, live, process).expect_err("refused");
        assert_eq!(error.code, ErrorCode::WindowNotFound);
        assert!(error.message.contains("different process"));
    }
}
