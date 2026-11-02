use super::session_endpoints;
use crate::system::cursor_overlay::pipe_name::{pipe_name, session_prefix};
use std::path::Path;

/// Deliberately not shaped like a home directory: the privacy scan reads
/// `C:\Users\<name>` as an operator identity wherever it appears, and an
/// endpoint hashes whatever root it is handed.
fn root() -> &'static Path {
    Path::new(r"C:\ProgramData\agent-desktop-fixture")
}

const SESSION: &str = "s0000001";

/// A session with nothing running still names the endpoint it would answer on
/// without an agent. A teardown that skipped it would leave the ordinary
/// single-cursor overlay drawing, which is the common case.
#[test]
fn the_agentless_endpoint_is_always_a_target() {
    let found = session_endpoints(root(), SESSION);

    assert!(
        found.contains(&pipe_name(root(), SESSION, None)),
        "a session's own endpoint must be reachable whether or not anything answered a listing"
    );
}

/// The prefix is what discovery matches on, so it has to be the prefix the
/// per-agent names actually carry. If these drifted apart, a listing would
/// match nothing and a disable would silently stop only the agent-less cursor
/// while every agent kept drawing.
#[test]
fn every_agent_endpoint_begins_with_the_prefix_discovery_looks_for() {
    let prefix = session_prefix(root(), SESSION);

    for agent in ["a", "agent-b", "subagent-00000003"] {
        let name = pipe_name(root(), SESSION, Some(agent));
        let bare = name
            .strip_prefix(r"\\.\pipe\")
            .expect("an endpoint is a pipe name");
        assert!(
            bare.starts_with(&prefix),
            "agent endpoint {bare} does not carry the prefix {prefix} discovery matches on"
        );
    }
}

/// Another session's agent must not be swept by this session's teardown. The
/// prefix carries the state root and the session, so it cannot match.
#[test]
fn another_sessions_agents_do_not_carry_this_sessions_prefix() {
    let prefix = session_prefix(root(), SESSION);
    let foreign = pipe_name(root(), "s0000002", Some("a"));
    let bare = foreign
        .strip_prefix(r"\\.\pipe\")
        .expect("an endpoint is a pipe name");

    assert!(
        !bare.starts_with(&prefix),
        "a disable for one session would have reached another session's agent"
    );
}
