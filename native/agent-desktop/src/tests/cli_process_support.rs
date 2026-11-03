#[cfg(target_os = "linux")]
static SESSION_LOCK: std::sync::Mutex<()> = std::sync::Mutex::new(());

pub(super) fn run_in_private_session() -> bool {
    #[cfg(target_os = "linux")]
    {
        if std::env::var_os("AGENT_DESKTOP_CLI_TEST_PRIVATE").is_some() {
            assert!(std::env::var_os("AGENT_DESKTOP_PRIVATE_SESSION").is_some());
            return false;
        }
        let _lock = SESSION_LOCK
            .lock()
            .unwrap_or_else(|error| error.into_inner());
        let thread = std::thread::current();
        let name = thread.name().expect("the test has a name");
        let output = std::process::Command::new("bash")
            .arg(concat!(
                env!("CARGO_MANIFEST_DIR"),
                "/../scripts/private-session.sh"
            ))
            .arg("--")
            .arg(std::env::current_exe().expect("the test executable"))
            .args(["--exact", name, "--nocapture"])
            .env("AGENT_DESKTOP_CLI_TEST_PRIVATE", "1")
            .output()
            .expect("start the test in a private session");
        assert!(
            output.status.success(),
            "private test exited {}: stdout={} stderr={}",
            output.status,
            String::from_utf8_lossy(&output.stdout),
            String::from_utf8_lossy(&output.stderr)
        );
        assert!(
            String::from_utf8_lossy(&output.stdout).contains("1 passed; 0 failed"),
            "the private test must execute exactly one case: {}",
            String::from_utf8_lossy(&output.stdout)
        );
        true
    }
    #[cfg(not(target_os = "linux"))]
    false
}

#[cfg(target_os = "linux")]
#[test]
fn batch_without_a_bus_stops_at_permission_preflight_without_dispatching() {
    let dir = super::unique_temp_dir("cli-no-bus");
    let batch = serde_json::json!([
        {"command": "session", "args": {"action": "start", "no_trace": true}},
        {"command": "wait", "args": {"event": "window-opened", "timeout": 100}}
    ]);
    let output = super::binary()
        .args(["batch", &batch.to_string()])
        .env("AGENT_DESKTOP_HOME", &dir)
        .env("XDG_RUNTIME_DIR", &dir)
        .env(
            "DBUS_SESSION_BUS_ADDRESS",
            format!("unix:path={}/absent-bus", dir.display()),
        )
        .env_remove("AT_SPI_BUS_ADDRESS")
        .env_remove("DISPLAY")
        .env_remove("WAYLAND_DISPLAY")
        .output()
        .expect("batch runs without a bus");
    let response: serde_json::Value = serde_json::from_slice(&output.stdout).unwrap();
    assert_eq!(output.status.code(), Some(1), "{response}");
    assert_eq!(response["ok"], false, "{response}");
    assert_eq!(response["error"]["code"], "PERM_DENIED", "{response}");
    assert_eq!(response["error"]["details"]["batch_index"], 1, "{response}");
    assert_eq!(
        response["error"]["details"]["batch_command"], "wait",
        "{response}"
    );
    assert!(
        response.get("data").is_none(),
        "no entries dispatched: {response}"
    );
    assert!(
        !dir.join("sessions").exists(),
        "preflight writes no session"
    );
    let _ = std::fs::remove_dir_all(dir);
}
