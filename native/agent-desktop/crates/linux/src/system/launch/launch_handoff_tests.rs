use super::*;

fn resident(pid: u32, ids: &[&str]) -> (Running, HashSet<String>) {
    (
        Running {
            executable: None,
            pid,
            instance: format!("boot:{pid}"),
            name: "tool".to_owned(),
        },
        ids.iter().map(|id| (*id).to_owned()).collect(),
    )
}

#[test]
fn one_resident_gaining_a_window_is_the_owner() {
    let before = [resident(7, &["old"]), resident(8, &["other"])];
    let after = [resident(7, &["old", "new"]), resident(8, &["other"])];
    assert_eq!(
        select_owner(&before, &after),
        Step::Owner(after[0].0.clone())
    );
}

#[test]
fn unchanged_windows_do_not_prove_a_handoff() {
    let before = [resident(7, &["old"])];
    assert_eq!(select_owner(&before, &before), Step::Wait);
}

#[test]
fn two_residents_gaining_windows_are_ambiguous() {
    let before = [resident(7, &[]), resident(8, &["old"])];
    let after = [resident(7, &["new"]), resident(8, &["old", "other"])];
    assert_eq!(select_owner(&before, &after), Step::Ambiguous(vec![7, 8]));
}

#[test]
fn a_replaced_process_instance_cannot_prove_a_handoff() {
    let before = [resident(7, &["old"])];
    let mut after = [resident(7, &["new"])];
    after[0].0.instance = "boot:replacement".to_owned();
    assert_eq!(select_owner(&before, &after), Step::Wait);
}

#[test]
fn losing_windows_does_not_prove_a_handoff() {
    let before = [resident(7, &["old", "closed"])];
    let after = [resident(7, &["old"])];
    assert_eq!(select_owner(&before, &after), Step::Wait);
}

#[test]
fn a_process_without_a_captured_baseline_cannot_prove_a_handoff() {
    assert_eq!(select_owner(&[], &[resident(7, &["new"])]), Step::Wait);
}

#[test]
fn a_different_pid_with_the_same_instance_token_is_not_a_resident() {
    let before = [resident(7, &["old"])];
    let mut after = [resident(8, &["new"])];
    after[0].0.instance = before[0].0.instance.clone();
    assert_eq!(select_owner(&before, &after), Step::Wait);
}
