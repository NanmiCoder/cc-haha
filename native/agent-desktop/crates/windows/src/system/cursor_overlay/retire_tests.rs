use super::retirement_targets;
use crate::system::cursor_overlay::pipe_name::{
    PROTOCOL_GENERATIONS, pipe_name, pipe_name_for_generation,
};
use std::path::Path;

/// Deliberately not shaped like a home directory: the privacy scan reads
/// `C:\Users\<name>` as an operator identity wherever it appears, and a pipe
/// name hashes whatever root it is handed, so a fixture only has to be a path.
fn root() -> &'static Path {
    Path::new(r"C:\ProgramData\agent-desktop-fixture")
}

const SESSION: &str = "s0000001";

/// While the ledger holds only the live generation, there is no earlier renderer to
/// clear and the sweep costs an enable nothing.
#[test]
fn the_shipped_ledger_gives_the_sweep_nothing_to_do() {
    assert!(retirement_targets(root(), SESSION, &PROTOCOL_GENERATIONS).is_empty());
}

/// What a bump must produce: the displaced generation's name becomes a target,
/// and the name this build is about to serve on never does. A sweep that
/// included the live name would send a `Disable` to the renderer it is about
/// to start, or end that renderer's process outright.
#[test]
fn a_bumped_ledger_targets_the_displaced_generation_and_never_the_live_one() {
    let targets = retirement_targets(root(), SESSION, &["w1", "w2"]);

    assert_eq!(
        targets,
        vec![pipe_name_for_generation(root(), SESSION, None, "w1")],
        "the generation the append displaced is the one to clear"
    );
    assert!(
        !targets.contains(&pipe_name_for_generation(root(), SESSION, None, "w2")),
        "the live generation must never be a retirement target"
    );
}

/// A target names this session and no other. The sweep runs on every enable,
/// so a target derived from another session would reach into that session's
/// renderer and disable it — or end its process.
///
/// The ledger here names generations the shipped one does not, so that the
/// live name is genuinely a different name and the assertion below is a real
/// question rather than a comparison of a value with itself.
#[test]
fn a_target_is_scoped_to_the_session_being_enabled() {
    let targets = retirement_targets(root(), SESSION, &["x1", "x2"]);

    assert_eq!(
        targets,
        vec![pipe_name_for_generation(root(), SESSION, None, "x1")]
    );
    assert!(
        !targets.contains(&pipe_name_for_generation(root(), "s0000002", None, "x1")),
        "another session's renderer is not this session's to retire"
    );
    assert!(
        !targets.contains(&pipe_name(root(), SESSION, None)),
        "and neither is the name this build is about to serve on"
    );
}
