use super::*;
use agent_desktop_core::system::process_state::ProcessState;
use std::cell::Cell;

#[test]
fn dead_pid_classifies_exited_without_consulting_probe() {
    let probe_calls = Cell::new(0);
    let state = classify(false, || {
        probe_calls.set(probe_calls.get() + 1);
        Ok(AxProbeResult::Responsive)
    })
    .unwrap();
    assert_eq!(state, ProcessState::Exited { code: None });
    assert_eq!(
        probe_calls.get(),
        0,
        "a dead pid must short-circuit before probing AX at all"
    );
}

#[test]
fn single_transient_cannot_complete_does_not_classify_unresponsive() {
    let calls = Cell::new(0);
    let state = classify(true, || {
        let n = calls.get() + 1;
        calls.set(n);
        if n == 1 {
            Ok(AxProbeResult::CannotComplete)
        } else {
            Ok(AxProbeResult::Responsive)
        }
    })
    .unwrap();
    assert_eq!(
        state,
        ProcessState::Running,
        "one transient AX blip on a healthy-but-busy app must not hard-fail as Unresponsive"
    );
    assert_eq!(calls.get(), 2, "a transient failure retries exactly once");
}

#[test]
fn two_consecutive_cannot_complete_classifies_unresponsive() {
    let calls = Cell::new(0);
    let state = classify(true, || {
        calls.set(calls.get() + 1);
        Ok(AxProbeResult::CannotComplete)
    })
    .unwrap();
    assert_eq!(state, ProcessState::Unresponsive);
    assert_eq!(
        calls.get(),
        2,
        "classification requires exactly a second consecutive CannotComplete, not more"
    );
}

#[test]
fn immediately_responsive_pid_classifies_running_with_one_probe() {
    let calls = Cell::new(0);
    let state = classify(true, || {
        calls.set(calls.get() + 1);
        Ok(AxProbeResult::Responsive)
    })
    .unwrap();
    assert_eq!(state, ProcessState::Running);
    assert_eq!(calls.get(), 1);
}

#[cfg(target_os = "macos")]
#[test]
fn exited_child_process_is_classified_exited_with_no_code() {
    let mut child = std::process::Command::new("/bin/cat")
        .stdin(std::process::Stdio::piped())
        .stdout(std::process::Stdio::null())
        .spawn()
        .expect("spawn /bin/cat");
    let pid = i32::try_from(child.id()).expect("child pid fits macOS pid_t");
    let instance = crate::system::process::process_identity::token_for_pid(pid)
        .expect("capture child process identity")
        .expect("child blocked on stdin is live");
    drop(child.stdin.take());
    child.wait().expect("wait for exit");

    let state = process_state_impl(
        agent_desktop_core::ProcessIdentity {
            pid: agent_desktop_core::ProcessId::try_from(pid).unwrap(),
            instance,
        },
        agent_desktop_core::Deadline::after(1_000).unwrap(),
    )
    .expect("process_state_impl should not error");
    assert_eq!(state, ProcessState::Exited { code: None });
}

#[cfg(target_os = "macos")]
#[test]
fn nonpositive_pid_is_never_alive() {
    assert!(!pid_is_alive(0));
    assert!(!pid_is_alive(-1));
}

#[cfg(target_os = "macos")]
#[test]
fn currently_running_pid_is_alive() {
    let pid = i32::try_from(std::process::id()).expect("test pid fits macOS pid_t");
    assert!(pid_is_alive(pid));
}
