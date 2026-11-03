use std::time::Duration;

use agent_desktop_core::{ErrorCode, ObservationOps};

use super::live_launch::{nonce, vscode_arguments};
use super::live_rig::{Rig, kind, refused, rig, signal};

fn launch(rig: &mut Rig) -> u32 {
    let program = "code".to_owned();
    let data = std::env::temp_dir()
        .join(nonce("chromium"))
        .to_string_lossy()
        .into_owned();
    rig.launched.spawn(&program, &vscode_arguments(&data))
}

#[test]
#[ignore = "drives a real desktop application; run through scripts/private-session.sh"]
fn chromium_live_a_killed_vscode_is_a_settled_stale_ref_in_one_pass() {
    let mut rig = rig();
    let pid = launch(&mut rig);
    let settled = rig.settled(pid, 200);
    let entry = rig
        .entries(&settled.frame, true)
        .into_iter()
        .map(|(_, entry)| entry)
        .find(|entry| entry.identity.role == "button" && entry.identity.name.is_some())
        .expect("a named button");
    let handle = rig.resolve(&entry).expect("resolves while alive");
    signal(pid, "KILL");
    let (outcome, elapsed) = rig.timed_resolve(&entry);
    let error = refused(outcome, "a killed app resolves nothing");
    println!(
        "chromium_live kill: {:?} kind {} in {} ms",
        error.code,
        kind(&error),
        elapsed.as_millis()
    );
    assert_eq!(error.code, ErrorCode::StaleRef);
    assert!(!error.is_explicitly_retryable());
    assert!(elapsed < Duration::from_millis(1_500));
    let held = rig
        .adapter
        .get_live_element(&handle, super::live_rig::deadline(4_000));
    assert!(matches!(held, Err(ref error) if error.code == ErrorCode::StaleRef));
}
