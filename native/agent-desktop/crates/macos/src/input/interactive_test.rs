use std::{process::Command, time::Duration};

const WORKER_ENV: &str = "AGENT_DESKTOP_INTERACTIVE_TEST_WORKER";

pub(crate) fn is_worker(name: &str) -> bool {
    std::env::var(WORKER_ENV).is_ok_and(|value| value == name)
}

pub(crate) fn run_bounded(test_filter: &str, worker: &str, timeout: Duration) {
    let executable = std::env::current_exe().expect("current test executable is available");
    let mut command = Command::new(executable);
    command
        .arg(test_filter)
        .arg("--nocapture")
        .env(WORKER_ENV, worker);
    let output =
        crate::system::process::run_with_timeout(&mut command, "interactive test worker", timeout)
            .unwrap_or_else(|error| {
                panic!("interactive test worker did not finish safely: {error}")
            });
    let stdout = String::from_utf8_lossy(&output.stdout);
    let stderr = String::from_utf8_lossy(&output.stderr);
    assert!(
        output.status.success(),
        "interactive test worker failed: {}\n{stderr}",
        output.status
    );
    assert!(
        stdout.contains("1 passed; 0 failed"),
        "interactive test worker for filter `{test_filter}` did not run exactly one test\nstdout: {stdout}\nstderr: {stderr}"
    );
}
