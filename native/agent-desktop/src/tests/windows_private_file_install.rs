#![cfg(target_os = "windows")]

use std::path::{Path, PathBuf};
use std::process::{Command, Output};

#[path = "windows_junction_fixture.rs"]
mod windows_junction_fixture;
use windows_junction_fixture::{entries_under, plant_junction};

#[path = "unique_scratch_dir.rs"]
mod unique_scratch_dir;
use unique_scratch_dir::unique_scratch_dir;

struct Scratch {
    root: PathBuf,
}

impl Scratch {
    fn create(label: &str) -> Self {
        Self {
            root: unique_scratch_dir("install", label),
        }
    }

    fn dir(&self, name: &str) -> PathBuf {
        let path = self.root.join(name);
        std::fs::create_dir_all(&path).expect("create scratch subdirectory");
        path
    }
}

impl Drop for Scratch {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.root);
    }
}

fn run_session_start(home: &Path) -> Output {
    Command::new(env!("CARGO_BIN_EXE_agent-desktop"))
        .args(["session", "start"])
        .env("HOME", home)
        .env("USERPROFILE", home)
        .env_remove("AGENT_DESKTOP_SESSION")
        .output()
        .expect("binary starts")
}

fn parse_envelope(output: &Output) -> serde_json::Value {
    serde_json::from_slice(&output.stdout).expect("stdout is one JSON envelope")
}

#[test]
fn session_start_through_a_junction_home_is_refused_by_the_installed_windows_ops() {
    let scratch = Scratch::create("junction");
    let home = scratch.dir("junction-home");
    let target = scratch.dir("junction-target");
    plant_junction(&home.join(".agent-desktop"), &target);

    let output = run_session_start(&home);
    let envelope = parse_envelope(&output);

    assert_eq!(
        output.status.code(),
        Some(1),
        "session start must fail structurally when ~/.agent-desktop is a junction; \
         success means the portable default wrote through the junction"
    );
    assert_eq!(envelope["ok"], false);
    let leaked = entries_under(&target);
    assert!(
        leaked.is_empty(),
        "no session artifact — file or directory — may land under the junction target: {leaked:?}"
    );
}

#[test]
fn session_start_in_a_real_home_succeeds_as_the_junction_control() {
    let scratch = Scratch::create("control");
    let home = scratch.dir("real-home");

    let output = run_session_start(&home);
    let envelope = parse_envelope(&output);

    assert_eq!(output.status.code(), Some(0));
    assert_eq!(envelope["ok"], true);
    let session_id = envelope["data"]["session_id"]
        .as_str()
        .expect("session start reports its session id");
    let manifest = home
        .join(".agent-desktop")
        .join("sessions")
        .join(session_id)
        .join("session.json");
    assert!(
        manifest.is_file(),
        "the control session manifest must exist under the real home"
    );
}

#[test]
fn status_probe_refuses_inherited_access_and_accepts_a_native_created_root() {
    let scratch = Scratch::create("readiness");
    let parent = scratch.dir("runtime");
    let acl = Command::new("icacls.exe")
        .arg(&parent)
        .args(["/grant", "*S-1-1-0:(OI)(CI)RX"])
        .output()
        .expect("icacls can grant inherited access on the fixture");
    assert!(acl.status.success(), "fixture ACL failed: {:?}", acl);
    let precreated = scratch.dir("runtime/precreated");
    let native = parent.join("native-private");
    let run = |home: &Path, args: &[&str]| {
        let output = Command::new(env!("CARGO_BIN_EXE_agent-desktop"))
            .args(args)
            .env("AGENT_DESKTOP_HOME", home)
            .env_remove("AGENT_DESKTOP_SESSION")
            .env_remove("AGENT_DESKTOP_AGENT_ID")
            .env_remove("AGENT_DESKTOP_CURSOR_OVERLAY_CHILD")
            .output()
            .expect("binary starts");
        assert!(output.status.success(), "native call failed: {:?}", output);
        parse_envelope(&output)
    };
    let status = ["status", "--check-session-storage"];
    let rejected = run(&precreated, &status);
    assert_eq!(rejected["data"]["session_storage"]["ready"], false);
    assert!(
        rejected["data"]["session_storage"]["message"]
            .as_str()
            .is_some_and(
                |message| message.contains("private file DACL grants an untrusted principal")
            )
    );
    assert!(!precreated.join("sessions").exists());

    for _ in 0..2 {
        let accepted = run(&native, &status);
        assert_eq!(accepted["data"]["session_storage"]["ready"], true);
        assert_eq!(
            std::fs::read_dir(native.join("sessions")).unwrap().count(),
            0,
            "readiness must leave no probe or session behind"
        );
    }
    let started = run(&native, &["session", "start", "--no-trace"]);
    assert!(started["data"]["session_id"].is_string());
}
