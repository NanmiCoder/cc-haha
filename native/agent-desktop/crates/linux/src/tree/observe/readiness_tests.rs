use std::time::Duration;

use super::*;
use crate::tree::live::test_support::read_of;
use crate::tree::vocabulary::role_numbers::{DOCUMENT_FRAME, DOCUMENT_WEB, PANEL};

const MS: fn(u64) -> Duration = Duration::from_millis;

fn run(curve: &[usize], remaining: Duration) -> Vec<Step> {
    let mut settle = Readiness::new(remaining);
    let mut steps = Vec::new();
    let mut waited = Duration::ZERO;
    for nodes in curve {
        let step = settle.after_walk(*nodes, waited, true);
        steps.push(step);
        match step {
            Step::Wait(gap) => waited += gap,
            Step::Settled | Step::GiveUp => break,
        }
    }
    steps
}

fn node(role: u32, children: Vec<WalkedNode<ObservedRead>>) -> WalkedNode<ObservedRead> {
    WalkedNode {
        payload: read_of(role, "n", &[]),
        children,
        truncated: false,
        child_count: None,
        source_index: 0,
        in_web_document: false,
    }
}

#[test]
fn settle_and_tree_predicate_boundaries() {
    let plateau = run(&[18, 18, 18, 18, 370, 380, 386, 386, 386], MS(60_000));
    assert_eq!(plateau.len(), 3);
    assert_eq!(plateau[2], Step::Settled);
    assert_eq!(
        run(&[66, 120, 226, 247, 247, 247], MS(60_000)).last(),
        Some(&Step::Settled)
    );
    assert_eq!(
        run(&[247, 247], MS(60_000)),
        vec![Step::Wait(POLL), Step::Wait(POLL)]
    );
    assert_eq!(run(&[20, 20], MS(200)), vec![Step::GiveUp]);
    let capped = run(&(0..40).collect::<Vec<_>>(), MS(1_000));
    assert_eq!(capped.last(), Some(&Step::GiveUp));
    assert_eq!(
        capped
            .iter()
            .filter(|step| matches!(step, Step::Wait(_)))
            .count(),
        3
    );
    assert_eq!(
        run(&[100, 100, 100], MS(1_000)).last(),
        Some(&Step::Settled)
    );

    let tree = node(PANEL, vec![node(PANEL, vec![node(DOCUMENT_WEB, vec![])])]);
    assert!(has_web_document(&tree));
    assert!(has_web_document(&node(
        PANEL,
        vec![node(DOCUMENT_FRAME, vec![])]
    )));
    let mut settle = Readiness::new(MS(60_000));
    assert_eq!(settle.after_walk(2, Duration::ZERO, true), Step::Wait(POLL));
    assert_eq!(settle.after_walk(2, Duration::ZERO, true), Step::Wait(POLL));
    assert_eq!(settle.after_walk(2, Duration::ZERO, true), Step::Settled);
    let mut settle = Readiness::new(MS(60_000));
    for _ in 0..2 {
        settle.after_walk(2, Duration::ZERO, false);
    }
    assert_eq!(
        settle.after_walk(2, Duration::ZERO, false),
        Step::Wait(POLL)
    );
    let mut cut = node(PANEL, vec![]);
    cut.child_count = Some(3);
    let cut_tree = node(PANEL, vec![node(PANEL, vec![cut])]);
    assert!(has_depth_cut(&cut_tree));
    assert!(!has_depth_cut(&node(PANEL, vec![node(PANEL, vec![])])));
}

#[test]
fn both_web_document_roles_require_a_read_non_busy_state() {
    use crate::tree::Field;
    use crate::tree::live::test_support::words;
    use crate::tree::vocabulary::state_bits::BUSY;
    for role in [DOCUMENT_WEB, DOCUMENT_FRAME] {
        let mut document = node(role, vec![]);
        assert!(has_web_document(&document));
        assert!(ready(&document));
        document.payload.node.traits.states = Field::Present(words(&[BUSY]));
        assert!(!ready(&document));
        document.payload.node.traits.states = Field::Failed("unread".to_owned());
        assert!(!ready(&document));
    }
}
