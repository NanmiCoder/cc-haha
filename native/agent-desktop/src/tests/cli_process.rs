use std::process::Command;

#[path = "cli_process_support.rs"]
mod support;

#[path = "cli_parse_error_tests.rs"]
mod parse_error_tests;

fn binary() -> Command {
    Command::new(env!("CARGO_BIN_EXE_agent-desktop"))
}

#[test]
fn clap_help_returns_success_without_structured_error_noise() {
    let output = binary().arg("--help").output().expect("binary starts");

    assert!(output.status.success());
    assert!(String::from_utf8_lossy(&output.stdout).contains("Usage:"));
    assert!(output.stderr.is_empty());
}

#[test]
fn clap_parse_failure_is_structured_on_stdout_with_exit_two() {
    let output = binary()
        .arg("--definitely-not-a-real-flag")
        .output()
        .expect("binary starts");
    let envelope: serde_json::Value =
        serde_json::from_slice(&output.stdout).expect("stdout is one JSON envelope");

    assert_eq!(output.status.code(), Some(2));
    assert_eq!(envelope["ok"], false);
    assert_eq!(envelope["command"], "unknown");
    assert_eq!(envelope["error"]["code"], "INVALID_ARGS");
    assert_eq!(
        envelope["error"]["disposition"]["delivery"],
        "not_delivered"
    );
    assert_eq!(envelope["error"]["disposition"]["retry"], "safe");
}

#[test]
fn version_has_exact_package_identity() {
    let output = binary().arg("version").output().expect("binary starts");
    let envelope: serde_json::Value =
        serde_json::from_slice(&output.stdout).expect("stdout is one JSON envelope");

    assert!(output.status.success());
    assert_eq!(envelope["ok"], true);
    assert_eq!(envelope["data"]["version"], env!("CARGO_PKG_VERSION"));
}

#[test]
fn relative_state_root_env_fails_version_before_dispatch() {
    let output = binary()
        .arg("version")
        .env("AGENT_DESKTOP_HOME", "relative/not-absolute")
        .output()
        .expect("binary starts");
    let envelope: serde_json::Value =
        serde_json::from_slice(&output.stdout).expect("stdout is one JSON envelope");

    assert_eq!(output.status.code(), Some(1));
    assert_eq!(envelope["ok"], false);
    assert_eq!(envelope["command"], "version");
    assert_eq!(envelope["error"]["code"], "INVALID_ARGS");
}

#[test]
fn empty_state_root_env_fails_session_start_before_dispatch() {
    let output = binary()
        .args(["session", "start"])
        .env("AGENT_DESKTOP_HOME", "")
        .output()
        .expect("binary starts");
    let envelope: serde_json::Value =
        serde_json::from_slice(&output.stdout).expect("stdout is one JSON envelope");

    assert_eq!(output.status.code(), Some(1));
    assert_eq!(envelope["ok"], false);
    assert_eq!(envelope["command"], "session");
    assert_eq!(envelope["error"]["code"], "INVALID_ARGS");
}

#[test]
fn valid_absolute_state_root_env_allows_version_and_creates_nothing() {
    let dir = std::env::temp_dir().join(format!(
        "agent-desktop-cli-process-{}-{}",
        std::process::id(),
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_nanos())
            .unwrap_or(0)
    ));
    let output = binary()
        .arg("version")
        .env("AGENT_DESKTOP_HOME", &dir)
        .output()
        .expect("binary starts");
    let envelope: serde_json::Value =
        serde_json::from_slice(&output.stdout).expect("stdout is one JSON envelope");

    assert!(output.status.success());
    assert_eq!(envelope["ok"], true);
    assert!(
        !dir.exists(),
        "preflight validation must not create the state root directory"
    );
}

#[test]
fn state_root_env_redirects_session_start_writes() {
    let dir = unique_temp_dir("cli-state-root-session");
    let output = binary()
        .args(["session", "start"])
        .env("AGENT_DESKTOP_HOME", &dir)
        .output()
        .expect("binary starts");
    let envelope: serde_json::Value =
        serde_json::from_slice(&output.stdout).expect("stdout is one JSON envelope");

    assert!(output.status.success());
    assert_eq!(envelope["ok"], true);
    let session_id = envelope["data"]["session_id"]
        .as_str()
        .expect("session start returns a session id");
    let manifest = dir.join("sessions").join(session_id).join("session.json");
    assert!(
        manifest.is_file(),
        "session manifest must land under the AGENT_DESKTOP_HOME root"
    );
    let _ = std::fs::remove_dir_all(&dir);
}

#[test]
fn status_reports_state_root_env_value_verbatim() {
    let dir = unique_temp_dir("cli-state-root-status");
    let output = binary()
        .arg("status")
        .env("AGENT_DESKTOP_HOME", &dir)
        .output()
        .expect("binary starts");
    let envelope: serde_json::Value =
        serde_json::from_slice(&output.stdout).expect("stdout is one JSON envelope");

    assert_eq!(envelope["ok"], true);
    assert_eq!(
        envelope["data"]["state_root"],
        dir.to_string_lossy().as_ref(),
        "status must report the env value verbatim"
    );
    let _ = std::fs::remove_dir_all(&dir);
}

#[test]
fn invalid_state_root_env_fails_batch_as_single_envelope() {
    let output = binary()
        .args(["batch", "[]"])
        .env("AGENT_DESKTOP_HOME", "relative/not-absolute")
        .output()
        .expect("binary starts");
    let envelope: serde_json::Value =
        serde_json::from_slice(&output.stdout).expect("stdout is one JSON envelope");

    assert_eq!(output.status.code(), Some(1));
    assert_eq!(envelope["ok"], false);
    assert_eq!(envelope["command"], "batch");
    assert_eq!(envelope["error"]["code"], "INVALID_ARGS");
    assert!(
        envelope.get("data").is_none(),
        "batch must fail as one error envelope, no entry results"
    );
}

#[cfg(target_os = "macos")]
#[test]
fn malformed_permission_helper_invocation_bypasses_clap_and_tracing() {
    const HELPER_ENV: [&str; 6] = [
        "AGENT_DESKTOP_PERMISSION_HELPER",
        "AGENT_DESKTOP_PERMISSION_OPERATION",
        "AGENT_DESKTOP_PERMISSION_TOKEN",
        "AGENT_DESKTOP_PERMISSION_PARENT_PID",
        "AGENT_DESKTOP_PERMISSION_PARENT_INSTANCE",
        "AGENT_DESKTOP_PERMISSION_EXECUTABLE",
    ];

    let mut command = binary();
    command.arg("--definitely-not-a-real-flag");
    for name in HELPER_ENV {
        command.env_remove(name);
    }
    let output = command
        .env("AGENT_DESKTOP_PERMISSION_HELPER", "invalid")
        .env("RUST_LOG", "trace")
        .output()
        .expect("binary starts");

    assert_eq!(output.status.code(), Some(2));
    assert!(output.stderr.is_empty());
    assert_eq!(
        output.stdout.iter().filter(|byte| **byte == b'\n').count(),
        1
    );
    assert_eq!(output.stdout.last(), Some(&b'\n'));
    let response: serde_json::Value =
        serde_json::from_slice(&output.stdout).expect("stdout is one JSON line");
    assert_eq!(response["version"], 1);
    assert_eq!(response["ok"], false);
    assert_eq!(response["error"], "invalid_helper_invocation");
}

#[test]
fn agent_identity_flag_overrides_environment_and_rejects_invalid_ids() {
    let output = binary()
        .args(["--agent-id", "worker-a", "session", "list"])
        .env("AGENT_DESKTOP_AGENT_ID", "../invalid")
        .env_remove("AGENT_DESKTOP_SESSION")
        .output()
        .unwrap();
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stdout)
    );
    let output = binary()
        .args(["session", "list"])
        .env("AGENT_DESKTOP_AGENT_ID", "../invalid")
        .env_remove("AGENT_DESKTOP_SESSION")
        .output()
        .unwrap();
    let response: serde_json::Value = serde_json::from_slice(&output.stdout).unwrap();
    assert_eq!(response["error"]["code"], "INVALID_ARGS");
}

#[cfg(unix)]
fn create_private_dir(dir: &std::path::Path) {
    use std::os::unix::fs::DirBuilderExt;
    std::fs::DirBuilder::new()
        .recursive(true)
        .mode(0o700)
        .create(dir)
        .expect("create state root");
}

#[cfg(not(unix))]
fn create_private_dir(dir: &std::path::Path) {
    std::fs::create_dir_all(dir).expect("create state root");
}

fn unique_temp_dir(prefix: &str) -> std::path::PathBuf {
    let dir = std::env::temp_dir().join(format!(
        "agent-desktop-{prefix}-{}-{}",
        std::process::id(),
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_nanos())
            .unwrap_or(0)
    ));
    create_private_dir(&dir);
    dir
}

fn start_session_in_dir(dir: &std::path::Path) -> String {
    let mut c = binary();
    c.args(["session", "start", "--no-trace"])
        .env("AGENT_DESKTOP_HOME", dir);
    let out = c.output().expect("session start runs");
    let env: serde_json::Value = serde_json::from_slice(&out.stdout).unwrap();
    env["data"]["session_id"].as_str().unwrap().to_owned()
}

fn run_batch(dir: &std::path::Path, cmds: serde_json::Value, extra: &[&str]) -> serde_json::Value {
    let mut c = binary();
    c.arg("batch")
        .arg(cmds.to_string())
        .args(extra)
        .env("AGENT_DESKTOP_HOME", dir);
    let o = c.output().expect("batch runs");
    serde_json::from_slice(&o.stdout).unwrap_or_else(|error| {
        panic!(
            "batch stdout is not JSON: {error}; stderr: {}",
            String::from_utf8_lossy(&o.stderr)
        )
    })
}

#[test]
fn batch_entry_after_mid_batch_session_end_is_skipped_without_aborting_batch() {
    if support::run_in_private_session() {
        return;
    }
    let dir = unique_temp_dir("cli-batch-session-end");
    let session_id = start_session_in_dir(&dir);
    let data = run_batch(
        &dir,
        serde_json::json!([
            {"command": "session", "session": session_id, "args": {"action": "end"}},
            {"command": "clipboard-clear", "session": session_id, "args": {}},
            {"command": "version", "args": {}},
        ]),
        &[],
    )["data"]
        .clone();
    assert_eq!(data["results"][0]["execution"], "completed");
    assert_eq!(data["results"][0]["ok"], true);
    assert_eq!(data["results"][0]["data"]["session_id"], session_id);
    assert!(data["results"][0]["data"]["ended_at"].is_number());
    assert_eq!(data["results"][1]["execution"], "not_started");
    assert_eq!(data["results"][1]["not_started_reason"], "session_ended");
    assert_eq!(data["results"][1]["ok"], false);
    assert_eq!(data["results"][1]["error"]["code"], "INVALID_ARGS");
    assert!(
        data["results"][1]["error"]["message"]
            .as_str()
            .is_some_and(|message| message.contains(session_id.as_str()))
    );
    assert_eq!(data["results"][2]["execution"], "completed");
    assert_eq!(data["results"][2]["ok"], true);
    assert_eq!(data["completed_entries"], 2);
    assert_eq!(data["not_started_entries"], 1);
    assert!(data.get("stopped").is_none());
    let next_id = start_session_in_dir(&dir);
    let stopped = run_batch(
        &dir,
        serde_json::json!([
            {"command": "session", "session": next_id, "args": {"action": "end"}},
            {"command": "version", "session": next_id, "args": {}},
            {"command": "version", "args": {}}
        ]),
        &["--stop-on-error"],
    )["data"]
        .clone();
    assert_eq!(stopped["stopped"]["reason"], "stop_on_error");
    assert_eq!(stopped["results"].as_array().unwrap().len(), 2);
    let manifest: serde_json::Value = serde_json::from_str(
        &std::fs::read_to_string(dir.join("sessions").join(&session_id).join("session.json"))
            .expect("ended manifest remains on disk"),
    )
    .expect("manifest is JSON");
    assert!(manifest["ended_at"].is_number());
    let _ = std::fs::remove_dir_all(&dir);
}

#[test]
fn batch_session_ended_skip_leaves_a_following_entry_of_another_session_running() {
    if support::run_in_private_session() {
        return;
    }
    let dir = unique_temp_dir("cli-batch-session-end-wait-cross");
    let sid_a = start_session_in_dir(&dir);
    let sid_b = start_session_in_dir(&dir);
    let env = run_batch(
        &dir,
        serde_json::json!([
            {"command": "session", "session": sid_a, "args": {"action": "end"}},
            {"command": "clipboard-clear", "session": sid_a, "args": {}},
            {"command": "version", "session": sid_b, "args": {}},
            {"command": "version", "args": {}}
        ]),
        &[],
    );
    let results = env["data"]["results"].as_array().unwrap();
    assert_eq!(results.len(), 4, "no hard-stop: {env}");
    assert_eq!(results[1]["not_started_reason"], "session_ended", "{env}");
    assert_eq!(
        results[2]["execution"], "completed",
        "entry of the other session dispatched: {env}"
    );
    assert!(env["data"].get("stopped").is_none(), "{env}");
    let _ = std::fs::remove_dir_all(&dir);
}

#[test]
fn batch_session_ended_skip_covers_a_following_entry_of_the_same_session() {
    if support::run_in_private_session() {
        return;
    }
    let dir = unique_temp_dir("cli-batch-session-end-wait-same");
    let sid_a = start_session_in_dir(&dir);
    let env = run_batch(
        &dir,
        serde_json::json!([
            {"command": "session", "session": sid_a, "args": {"action": "end"}},
            {"command": "clipboard-clear", "session": sid_a, "args": {}},
            {"command": "version", "session": sid_a, "args": {}},
            {"command": "version", "args": {}}
        ]),
        &[],
    );
    let results = env["data"]["results"].as_array().unwrap();
    assert_eq!(results.len(), 4, "no hard-stop: {env}");
    assert_eq!(results[1]["not_started_reason"], "session_ended", "{env}");
    assert_eq!(
        results[2]["not_started_reason"], "session_ended",
        "entry of the ended session skipped: {env}"
    );
    assert!(env["data"].get("stopped").is_none(), "{env}");
    let _ = std::fs::remove_dir_all(&dir);
}
