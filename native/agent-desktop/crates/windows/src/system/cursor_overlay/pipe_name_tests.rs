use super::{
    CHILD_ARGV_FLAG, PROTOCOL_GENERATION, PROTOCOL_GENERATIONS, child_arguments,
    parse_child_arguments, pipe_name, pipe_name_for_generation, retired_generations,
};
use std::path::Path;

/// Deliberately not shaped like a home directory. The privacy scan treats
/// `C:\Users\<name>` as an operator identity wherever it appears, and it is
/// right to: a rule that made an exception for invented names could not tell
/// one from a real account captured by a probe. The pipe name hashes whatever
/// root it is given, so the fixture only has to be a path.
fn root() -> &'static Path {
    Path::new(r"C:\ProgramData\agent-desktop-fixture")
}

#[test]
fn the_same_root_and_session_always_resolve_to_the_same_name() {
    assert_eq!(
        pipe_name(root(), "s0000001", None),
        pipe_name(root(), "s0000001", None)
    );
}

#[test]
fn a_different_session_resolves_to_a_different_name() {
    assert_ne!(
        pipe_name(root(), "s0000001", None),
        pipe_name(root(), "s0000002", None)
    );
}

#[test]
fn a_different_state_root_resolves_to_a_different_name() {
    assert_ne!(
        pipe_name(root(), "s0000001", None),
        pipe_name(Path::new(r"D:\elsewhere\.agent-desktop"), "s0000001", None)
    );
}

/// The generation is why a renderer left by an earlier build cannot keep
/// serving a rebuilt binary's controls: it answers on a name the new build
/// never asks for.
#[test]
fn two_generations_resolve_to_different_names() {
    assert_ne!(
        pipe_name_for_generation(root(), "s0000001", None, "w1"),
        pipe_name_for_generation(root(), "s0000001", None, "w2")
    );
}

#[test]
fn the_name_is_a_local_pipe_path() {
    let name = pipe_name(root(), "s0000001", None);

    assert!(
        name.starts_with(r"\\.\pipe\"),
        "the name must be a local named pipe, got {name}"
    );
    assert!(
        !name.contains("s0000001"),
        "the session id is hashed rather than embedded, so the name carries no identity"
    );
}

/// The environment block of another process cannot be read from outside, so
/// the session and generation ride in argv where a command-line enumeration
/// can find them.
#[test]
fn the_child_argv_names_its_session_and_generation() {
    let arguments = child_arguments("s0000001", None);

    assert_eq!(arguments[0], CHILD_ARGV_FLAG);
    assert_eq!(
        parse_child_arguments(&arguments),
        Some(("s0000001".to_owned(), PROTOCOL_GENERATION.to_owned(), None))
    );
}

#[test]
fn a_command_line_that_is_not_ours_parses_to_nothing() {
    assert_eq!(parse_child_arguments(&["snapshot".to_owned()]), None);
    assert_eq!(
        parse_child_arguments(&[CHILD_ARGV_FLAG.to_owned()]),
        None,
        "the flag alone names no session, so it is not a child of ours"
    );
    assert_eq!(
        parse_child_arguments(&[CHILD_ARGV_FLAG.to_owned(), String::new(), "w1".to_owned()]),
        None,
        "an empty session id is not a session"
    );
}

/// A ledger holding only the live generation retires nothing, so
/// the sweep has nothing to do. Asserted rather than assumed, because a sweep
/// that quietly targeted the live generation would disable the renderer it
/// just started.
#[test]
fn a_ledger_of_one_generation_retires_nothing() {
    assert!(retired_generations(&["w1"]).is_empty());
}

/// The rule the ledger exists to enforce, proved on a ledger that has been
/// appended to. Bumping the generation is an append, and this is what an
/// append does to the entry it displaces.
#[test]
fn appending_a_generation_moves_the_previous_one_into_the_retired_set() {
    let before: [&'static str; 2] = ["w1", "w2"];
    let after: [&'static str; 3] = ["w1", "w2", "w3"];

    assert_eq!(retired_generations(&before), ["w1"]);
    assert_eq!(
        retired_generations(&after),
        ["w1", "w2"],
        "an append retires the generation it displaced, and keeps every earlier one retired"
    );
}

/// The live generation is never a retirement target. A sweep that included it
/// would derive the name this build is about to use and disable whatever
/// answers there.
#[test]
fn the_generation_this_build_speaks_is_never_a_retirement_target() {
    let ledger: [&'static str; 3] = ["w1", "w2", "w3"];

    assert!(
        !retired_generations(&ledger).contains(&"w3"),
        "the newest generation of a ledger must never be swept"
    );
    assert!(
        !retired_generations(&PROTOCOL_GENERATIONS).contains(&PROTOCOL_GENERATION),
        "the current generation must never be swept"
    );
}

/// An empty ledger is not a state the constant can be in, but the function
/// takes any ledger and must not panic indexing one.
#[test]
fn an_empty_ledger_retires_nothing_rather_than_panicking() {
    assert!(retired_generations(&[]).is_empty());
}

/// Two agents of one session must not share an endpoint, or the second
/// renderer would lose the first-instance race and withdraw, leaving one
/// cursor for both.
#[test]
fn two_agents_of_one_session_answer_on_different_names() {
    assert_ne!(
        pipe_name(root(), "s0000001", Some("a")),
        pipe_name(root(), "s0000001", Some("b"))
    );
}

/// The same agent name in two sessions is two different agents. The session
/// segment carries the state root and the generation, so they cannot collide.
#[test]
fn one_agent_name_in_two_sessions_is_two_endpoints() {
    assert_ne!(
        pipe_name(root(), "s0000001", Some("a")),
        pipe_name(root(), "s0000002", Some("a"))
    );
}

/// An agent-less caller keeps the endpoint it had before agents existed, so a
/// renderer already serving a plain session stays reachable.
#[test]
fn naming_no_agent_leaves_the_original_endpoint_untouched() {
    let bare = pipe_name(root(), "s0000001", None);

    assert!(
        !bare
            .trim_start_matches(r"\\.\pipe\agent-desktop-cursor-")
            .contains('-'),
        "an agent-less endpoint must carry one segment, got {bare}"
    );
}

/// The agent segment is hashed under its own tag, so an agent whose id equals
/// the session id does not produce the session's own segment twice.
#[test]
fn an_agent_named_like_its_session_does_not_repeat_the_session_segment() {
    let name = pipe_name(root(), "s0000001", Some("s0000001"));
    let tail = name
        .rsplit('-')
        .next()
        .expect("an agent endpoint has a trailing segment");
    let head = name
        .trim_start_matches(r"\\.\pipe\agent-desktop-cursor-")
        .split('-')
        .next()
        .expect("an agent endpoint has a leading segment");

    assert_ne!(
        head, tail,
        "the two segments must be hashed under different domains"
    );
}

/// The child carries its agent so the renderer it becomes serves the endpoint
/// its parent reached for. The agent-less round trip is
/// `the_child_argv_names_its_session_and_generation`'s own case.
#[test]
fn the_child_argv_round_trips_its_agent() {
    let with_agent = child_arguments("s0000001", Some("a"));
    assert_eq!(
        parse_child_arguments(&with_agent),
        Some((
            "s0000001".to_owned(),
            PROTOCOL_GENERATION.to_owned(),
            Some("a".to_owned())
        ))
    );
}
