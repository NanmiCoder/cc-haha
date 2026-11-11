use super::*;

fn popup_world(above: Vec<StackedWindow>) -> World {
    let mut facts = gtk4_facts();
    facts.window = rect(208, 50, 214, 32);
    facts.screen = rect(0, 0, 214, 32);
    let mut stack = windowing((541, 189), above);
    stack.coordinate_origin = Some((345, 183));
    let mut world = World::new(facts, Some(stack));
    reaching(&mut world);
    world
}

#[test]
fn a_popup_item_uses_its_own_local_origin_for_aim_and_descent() {
    let mut world = popup_world(vec![]);
    assert_eq!(test(&mut world, (660, 249)), HitTestResult::ReachesTarget);
    assert_eq!(world.nodes.points.first(), Some(&(315, 66)));
}

#[test]
fn a_window_above_the_popup_still_intercepts_its_item() {
    let mut world = popup_world(vec![stacked(20, rect(650, 230, 100, 80))]);
    assert!(matches!(
        test(&mut world, (660, 249)),
        HitTestResult::InterceptedBy { .. }
    ));
    assert!(world.nodes.calls.is_empty());
}
