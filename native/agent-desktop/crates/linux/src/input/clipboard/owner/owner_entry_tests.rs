use std::cell::Cell;

use super::*;

fn matching() -> OwnerEnv {
    OwnerEnv {
        marker: Some(GENERATION.to_string()),
        build: Some(build_identity()),
        payload_fd: Some("7".into()),
        display: Some(":7".into()),
        nonce: Some("abcdefgh".into()),
    }
}

fn runs_owner(env: OwnerEnv) -> (i32, bool) {
    let ran = Cell::new(false);
    let status = run_checked(env, |_| {
        ran.set(true);
        EXIT_OK
    });
    (status, ran.get())
}

#[test]
fn no_marker_is_a_usage_error_and_never_starts_the_owner() {
    let mut env = matching();
    env.marker = None;
    assert_eq!(runs_owner(env), (EXIT_USAGE, false));
}

#[test]
fn a_build_identity_that_differs_never_starts_the_owner() {
    let mut env = matching();
    env.build = Some("0.0.0:1".into());
    assert_eq!(runs_owner(env), (EXIT_USAGE, false));
    let mut missing = matching();
    missing.build = None;
    assert_eq!(runs_owner(missing), (EXIT_USAGE, false));
}

#[test]
fn another_protocol_generation_never_starts_the_owner() {
    let mut env = matching();
    env.marker = Some((GENERATION + 1).to_string());
    assert_eq!(runs_owner(env), (EXIT_USAGE, false));
}
