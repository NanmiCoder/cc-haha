use super::*;

#[test]
fn gtk4_hits_follow_both_positions_and_never_reach_through_a_cover() {
    let mut world = World::new(gtk4_facts(), None);
    reaching(&mut world);
    for origin in [(60, 60), (380, 190)] {
        let point = (origin.0 + 398, origin.1 + 300);
        world.windowing = Some(windowing(origin, vec![]));
        let reads = world.nodes.points.len();
        assert_eq!(test(&mut world, point), HitTestResult::ReachesTarget);
        assert_eq!(world.nodes.points.get(reads), Some(&(398, 300)));
        let cover = stacked(20, rect(origin.0 + 300, origin.1 + 200, 200, 200));
        world
            .windowing
            .as_mut()
            .expect("window")
            .snapshot
            .stack
            .push(cover);
        let covered = test(&mut world, point);
        assert!(matches!(covered, HitTestResult::InterceptedBy { .. }));
        world
            .windowing
            .as_mut()
            .expect("window")
            .snapshot
            .stack
            .pop();
        assert_eq!(test(&mut world, point), HitTestResult::ReachesTarget);
        assert_eq!(test(&mut world, (10, 10)), HitTestResult::Unknown);
    }
}

#[test]
fn gtk4_inside_a_client_side_shadow_is_calibrated_from_the_origin_after_the_shadow() {
    let mut shadowed = windowing((302, 260), vec![]);
    shadowed.snapshot.stack[0].shadow = (61, 55, 0, 0);
    let mut world = World::new(gtk4_facts(), Some(shadowed));
    reaching(&mut world);

    assert_eq!(test(&mut world, (800, 620)), HitTestResult::ReachesTarget);
    assert_eq!(world.nodes.points.first(), Some(&(437, 305)));
    let mut outside = World::new(gtk4_facts(), Some(windowing((302, 260), vec![])));
    reaching(&mut outside);
    assert_eq!(test(&mut outside, (800, 620)), HitTestResult::Unknown);
}

#[test]
fn a_hidden_or_unmapped_window_is_unknown() {
    for (hidden, mapped) in [(true, true), (false, false)] {
        let mut stacking = windowing((100, 137), vec![]);
        stacking.snapshot.stack[0].flags.hidden = hidden;
        stacking.snapshot.stack[0].flags.mapped = mapped;
        let mut world = World::new(gtk3_facts(), Some(stacking));
        reaching(&mut world);
        assert_eq!(test(&mut world, (310, 154)), HitTestResult::Unknown);
    }
}

#[test]
fn a_spent_deadline_with_no_x11_answer_is_the_timeout_and_not_unknown() {
    let mut world = World::new(gtk3_facts(), None);
    let spent = Deadline::after(1).expect("a deadline builds");
    std::thread::sleep(std::time::Duration::from_millis(20));
    let error = hit_test_via(&mut world, &el("/target"), &el("/frame"), (310, 154), spent)
        .expect_err("a spent deadline is an error");
    assert_eq!(error.code, agent_desktop_core::ErrorCode::Timeout);
}
