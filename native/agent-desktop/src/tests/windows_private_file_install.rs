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
