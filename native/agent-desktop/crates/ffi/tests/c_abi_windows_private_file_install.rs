#![cfg(target_os = "windows")]

mod common;

use agent_desktop_core::session::{StartSessionOptions, start_session};
use agent_desktop_core::{PrivateFileOps, install_private_file_ops};
use common::{ad_adapter_create, ad_adapter_destroy, with_isolated_home};
use std::path::PathBuf;

#[path = "../../../src/tests/windows_junction_fixture.rs"]
mod windows_junction_fixture;
use windows_junction_fixture::{entries_under, plant_junction};

struct ProbeOps;

impl PrivateFileOps for ProbeOps {}

/// Core's five private-file primitives are `pub(crate)`, so the behavioral arm
/// reaches them through the public `session::start_session` surface instead:
/// the first-install rejection proves adapter construction already installed
/// an implementation (the windows arm installs only `WindowsPrivateFile`), and
/// the junction refusal ties that install to hardened behavior the portable
/// default measurably lacks. The spawned-binary junction proof in the CLI
/// crate covers the other consumer.
#[test]
fn adapter_create_without_ad_init_installs_the_windows_private_file_ops() {
    unsafe {
        let adapter = ad_adapter_create();
        assert!(
            !adapter.is_null(),
            "ad_adapter_create must succeed without any prior ad_init call"
        );
        ad_adapter_destroy(adapter);
    }

    let Err(rejected) = install_private_file_ops(Box::new(ProbeOps)) else {
        panic!(
            "a fresh install must be rejected because adapter construction \
             already installed the Windows private-file implementation"
        );
    };
    drop(rejected);

    with_isolated_home(|| {
        let home = PathBuf::from(std::env::var_os("HOME").expect("isolated HOME is set"));
        let target = home.join("junction-target");
        std::fs::create_dir_all(&target).expect("create junction target");
        plant_junction(&home.join(".agent-desktop"), &target);

        let started = start_session(StartSessionOptions::default());

        assert!(
            started.is_err(),
            "a manifest write through a junction component must be refused \
             by the installed WindowsPrivateFile"
        );
        let leaked = entries_under(&target);
        assert!(
            leaked.is_empty(),
            "no session artifact — file or directory — may land under the junction target: {leaked:?}"
        );
    });
}
