use super::*;

const PROCESS_TIMEOUT: Duration = Duration::from_secs(1);

fn process_exists(process: i32) -> bool {
    unsafe extern "C" {
        fn kill(pid: i32, signal: i32) -> i32;
    }
    unsafe { kill(process, 0) == 0 }
}

#[test]
fn successful_process_returns_output() {
    let mut command = Command::new("/bin/echo");
    command.arg("ok");
    let output = run_with_timeout(&mut command, "echo", Duration::from_secs(1)).unwrap();

    assert!(output.status.success());
    assert_eq!(String::from_utf8_lossy(&output.stdout).trim(), "ok");
}

#[test]
fn slow_process_is_killed_within_the_absolute_deadline() {
    let mut command = Command::new("/bin/sleep");
    command.arg("5");
    let error = run_with_timeout(&mut command, "sleep", PROCESS_TIMEOUT)
        .expect_err("slow process must time out");

    assert_eq!(error.code, ErrorCode::Timeout);
    assert!(
        error.platform_detail.is_none(),
        "subprocess cleanup failed: {:?}",
        error.platform_detail
    );
}

#[test]
fn descendant_holding_stdout_is_killed_with_its_process_group() {
    let mut command = Command::new("/bin/sh");
    command.args(["-c", "trap '' TERM; sleep 60 >&1 & exit 0"]);
    let error = run_with_timeout(&mut command, "pipe-holder", PROCESS_TIMEOUT)
        .expect_err("inherited pipe must not outlive the deadline");

    assert_eq!(error.code, ErrorCode::Timeout);
    assert!(
        error.platform_detail.is_none(),
        "subprocess cleanup failed: {:?}",
        error.platform_detail
    );
}

#[test]
fn injected_group_kill_failure_is_reported_without_blocking_wait() {
    let mut command = Command::new("/bin/sleep");
    command.arg("60");
    configure_process_group(&mut command);
    let mut child = command.spawn().unwrap();
    let process_group = i32::try_from(child.id()).expect("child pid fits macOS pid_t");
    let deadline = Instant::now() + Duration::from_millis(30);
    let failures = terminate_process_group_with(&mut child, process_group, deadline, |_, _| {
        Err(std::io::Error::new(
            std::io::ErrorKind::PermissionDenied,
            "injected failure",
        ))
    });
    let _ = child.kill();

    assert!(
        failures
            .iter()
            .any(|failure| failure.contains("injected failure"))
    );
}

#[test]
fn zombie_only_group_does_not_turn_sigkill_eperm_into_cleanup_failure() {
    let mut command = Command::new("/usr/bin/true");
    configure_process_group(&mut command);
    let mut child = command.spawn().unwrap();
    let process_group = i32::try_from(child.id()).expect("child pid fits macOS pid_t");
    std::thread::sleep(Duration::from_millis(25));
    let mut signals = Vec::new();
    let deadline = Instant::now() + Duration::from_millis(100);
    let failures =
        terminate_process_group_with(&mut child, process_group, deadline, |group, signal| {
            signals.push(signal);
            match signal {
                15 => Ok(true),
                9 => {
                    assert!(process_exists(group));
                    Err(std::io::Error::from_raw_os_error(POSIX_EPERM))
                }
                0 => Ok(false),
                _ => unreachable!(),
            }
        });

    assert_eq!(signals, [15, 9, 0]);
    assert!(failures.is_empty());
    assert!(child.try_wait().unwrap().is_some());
}

#[test]
fn oversized_output_is_capped_with_stderr_context() {
    let mut command = Command::new("/bin/sh");
    command.args(["-c", "echo diagnostic-marker >&2; yes X | head -c 9000000"]);
    let error = run_with_timeout(&mut command, "oversized", Duration::from_secs(5))
        .expect_err("oversized output must fail");

    assert_eq!(error.code, ErrorCode::AppUnresponsive);
    assert!(
        error.details.unwrap()["stderr_tail"]
            .as_str()
            .is_some_and(|tail| tail.contains("diagnostic-marker"))
    );
}

#[test]
fn output_context_keeps_latest_bytes() {
    let mut tail = vec![b'a'; OUTPUT_CONTEXT_BYTES];
    append_tail(&mut tail, b"final diagnostic");

    assert_eq!(tail.len(), OUTPUT_CONTEXT_BYTES);
    assert!(tail.ends_with(b"final diagnostic"));
}
