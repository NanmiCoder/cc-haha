use std::cell::Cell;
use std::time::Duration;

use agent_desktop_core::{AdapterError, Deadline, HitTestResult, Point};

use super::{MOTION_GAP, verdict};
use crate::system::shell::fake_tree::{FakeTree, PANEL, at, element, gnome_shell};
use crate::system::shell::light::{Light, Nodes};
use crate::tree::AtspiElement;

const TARGET: &str = "/clear";

fn centre() -> Point {
    Point { x: 658.0, y: 550.0 }
}

fn deadline() -> Deadline {
    Deadline::after(10_000).expect("a deadline builds")
}

fn verdict_on(nodes: &impl Nodes) -> HitTestResult {
    verdict(
        nodes,
        &element("/w"),
        &element(TARGET),
        &centre(),
        &mut |_| {},
        deadline(),
    )
    .expect("a verdict")
}

#[test]
fn a_clean_target_is_reached() {
    assert_eq!(
        verdict_on(&gnome_shell(true, false)),
        HitTestResult::ReachesTarget
    );
}

#[test]
fn a_descendant_of_the_target_over_the_point_still_reaches_it() {
    let mut tree = gnome_shell(true, false);
    tree.add(Some(TARGET), "/icon", PANEL, "", at(640, 540, 20, 20));
    assert_eq!(verdict_on(&tree), HitTestResult::ReachesTarget);
}

#[test]
fn a_sibling_painted_over_the_target_is_unproven() {
    let mut tree = gnome_shell(true, false);
    tree.add(Some("/p2"), "/banner", PANEL, "", at(600, 520, 200, 60));
    assert_eq!(verdict_on(&tree), HitTestResult::Unknown);
}

#[test]
fn a_cover_inside_the_popup_but_after_the_target_is_unproven() {
    let mut tree = gnome_shell(true, false);
    tree.add(Some("/footer"), "/badge", PANEL, "", at(650, 545, 20, 20));
    assert_eq!(verdict_on(&tree), HitTestResult::Unknown);
}

#[test]
fn a_node_that_could_not_be_read_may_be_a_cover_so_the_verdict_is_unproven() {
    let mut tree = gnome_shell(true, false);
    tree.add(Some("/p2"), "/banner", PANEL, "", at(600, 520, 200, 60));
    tree.vanish("/banner");
    assert_eq!(verdict_on(&tree), HitTestResult::Unknown);
}

#[test]
fn nodes_under_the_target_or_not_showing_do_not_count() {
    let mut tree = gnome_shell(true, false);
    tree.add(Some("/p2"), "/ghost", PANEL, "", at(600, 520, 200, 60));
    tree.hide("/ghost");
    assert_eq!(verdict_on(&tree), HitTestResult::ReachesTarget);
}

#[test]
fn a_target_that_is_not_showing_is_unproven() {
    assert_eq!(
        verdict_on(&gnome_shell(false, false)),
        HitTestResult::Unknown
    );
}

#[test]
fn a_point_outside_every_showing_node_is_unproven() {
    let tree = gnome_shell(true, false);
    let outcome = verdict(
        &tree,
        &element("/w"),
        &element(TARGET),
        &Point { x: -50.0, y: -50.0 },
        &mut |_| {},
        deadline(),
    )
    .expect("a verdict");
    assert_eq!(outcome, HitTestResult::Unknown);
}

struct Sliding<'a> {
    tree: &'a FakeTree,
    reads: Cell<i32>,
}

impl Nodes for Sliding<'_> {
    fn read(&self, element: &AtspiElement) -> Result<Light, AdapterError> {
        let mut light = self.tree.read(element)?;
        if element.path() == TARGET {
            self.reads.set(self.reads.get() + 1);
            if let Some(extents) = light.extents.as_mut() {
                extents.x += self.reads.get();
            }
        }
        Ok(light)
    }
}

#[test]
fn a_target_that_moves_between_the_two_reads_is_unproven() {
    let tree = gnome_shell(true, false);
    let sliding = Sliding {
        tree: &tree,
        reads: Cell::new(0),
    };
    assert_eq!(verdict_on(&sliding), HitTestResult::Unknown);
}

#[test]
fn the_two_reads_are_at_least_fifty_milliseconds_apart() {
    let tree = gnome_shell(true, false);
    let mut paused: Vec<Duration> = Vec::new();
    verdict(
        &tree,
        &element("/w"),
        &element(TARGET),
        &centre(),
        &mut |gap| paused.push(gap),
        deadline(),
    )
    .expect("a verdict");
    assert_eq!(paused, vec![MOTION_GAP]);
    assert!(MOTION_GAP >= Duration::from_millis(50));
}
