use super::{RaiseWitness, responded_since};

fn witness(
    foreground: isize,
    foreground_is_shell_core_window: bool,
    children: &[isize],
) -> RaiseWitness {
    RaiseWitness {
        foreground,
        foreground_is_shell_core_window,
        shell_core_window_root_children: children.to_vec(),
    }
}

#[test]
fn identical_readings_have_not_moved() {
    let baseline = witness(1, false, &[10, 20]);
    let current = witness(1, false, &[10, 20]);

    assert!(!current.moved_since(&baseline));
}

#[test]
fn the_foreground_moving_to_a_shell_core_window_is_a_response() {
    let baseline = witness(1, false, &[10, 20]);
    let current = witness(2, true, &[10, 20]);

    assert!(current.moved_since(&baseline));
}

/// Two properties in one reading: a foreground change alone is not enough
/// (the moved-to window must itself be a shell-host CoreWindow), and the
/// flag that governs the verdict is the fresh poll's, never the pre-raise
/// baseline's - `baseline` is flagged `true` here precisely so an
/// implementation that mistakenly reads `witness`'s flag instead of `self`'s
/// would report a response and fail this assertion.
#[test]
fn a_foreground_change_to_a_non_shell_window_is_not_a_response_regardless_of_the_baselines_flag() {
    let baseline = witness(1, true, &[10, 20]);
    let current = witness(2, false, &[10, 20]);

    assert!(!current.moved_since(&baseline));
}

/// The flag alone, without the foreground actually changing, must not read
/// as a response - the two conditions are joined by `&&`, not read
/// independently.
#[test]
fn an_unchanged_foreground_flagged_as_a_shell_core_window_is_not_a_response() {
    let baseline = witness(1, false, &[10, 20]);
    let current = witness(1, true, &[10, 20]);

    assert!(!current.moved_since(&baseline));
}

#[test]
fn a_change_to_the_shell_core_window_root_children_is_a_response_on_its_own() {
    let baseline = witness(1, false, &[10, 20]);
    let current = witness(1, false, &[10, 20, 30]);

    assert!(current.moved_since(&baseline));
}

#[test]
fn responded_since_with_no_witness_is_always_false() {
    assert!(!responded_since(&None));
}
