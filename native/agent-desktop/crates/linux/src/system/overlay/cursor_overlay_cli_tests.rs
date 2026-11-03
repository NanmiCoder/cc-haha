use std::process::Command;

use serde_json::Value;
use x11rb::connection::Connection;
use x11rb::protocol::xproto::*;
use x11rb::rust_connection::RustConnection;

fn cli(args: &[&str]) -> Value {
    let binary = std::env::var_os("AGENT_DESKTOP_TEST_BINARY").expect("candidate CLI");
    let output = Command::new(binary)
        .args(args)
        .env_remove("AGENT_DESKTOP_SESSION")
        .env_remove("AGENT_DESKTOP_AGENT_ID")
        .output()
        .expect("CLI process exits");
    let answer: Value = serde_json::from_slice(&output.stdout).expect("JSON envelope");
    assert!(output.status.success(), "{answer}");
    assert_eq!(answer["ok"], true, "{answer}");
    answer["data"].clone()
}

fn owned(connection: &RustConnection, root: Window, session: &str) -> Vec<Window> {
    let owner = connection
        .intern_atom(false, b"_AGENT_DESKTOP_CURSOR_OWNER")
        .unwrap()
        .reply()
        .unwrap()
        .atom;
    connection
        .query_tree(root)
        .unwrap()
        .reply()
        .unwrap()
        .children
        .into_iter()
        .filter(|window| {
            connection
                .get_property(false, *window, owner, AtomEnum::STRING, 0, 1024)
                .unwrap()
                .reply()
                .ok()
                .and_then(|property| {
                    serde_json::from_slice::<(String, Option<String>)>(&property.value).ok()
                })
                .is_some_and(|(id, _)| id == session)
        })
        .collect()
}

#[test]
#[ignore = "private headless Wayland and AGENT_DESKTOP_TEST_BINARY pointing to the candidate CLI"]
fn live_wayland_cursor_cli_reports_unrendered_without_x11_fallback() {
    std::env::var("AGENT_DESKTOP_PRIVATE_SESSION").expect("private desktop");
    assert!(!std::env::var("WAYLAND_DISPLAY").unwrap().is_empty());
    let (oracle, index) = x11rb::connect(None).expect("private X11 fallback oracle");
    let root = oracle.setup().roots[index].root;
    let started = cli(&["session", "start", "--cursor", "--no-trace"]);
    assert_eq!(started["rendered"], false, "{started}");
    let session = started["session_id"].as_str().expect("session id");
    assert!(owned(&oracle, root, session).is_empty());
    let enabled = cli(&["--session", session, "cursor-overlay", "enable"]);
    assert_eq!(enabled["rendered"], false, "{enabled}");
    assert!(owned(&oracle, root, session).is_empty());
    cli(&["--session", session, "cursor-overlay", "disable"]);
    cli(&["session", "end", session]);
    assert!(owned(&oracle, root, session).is_empty());
}
