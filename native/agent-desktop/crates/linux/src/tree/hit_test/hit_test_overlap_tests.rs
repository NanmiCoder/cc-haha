use super::*;
use agent_desktop_core::{DeliverySemantics, ErrorCode};

#[test]
fn native_target_landings_do_not_prove_sibling_stacking_order() {
    for (name, version) in [("gtk", "3.24"), ("gtk", "4.14"), ("Qt", "6.10")] {
        let mut facts = gtk3_facts();
        facts.toolkit = toolkit(name, version);
        if name == "gtk" && version.starts_with('4') {
            facts.screen = rect(0, 0, 420, 34);
        }
        let mut world = reachable(facts, (100, 137), vec![]);
        world.nodes.described.insert(
            "/other".to_owned(),
            Described {
                window_extents: Some(rect(0, 0, 420, 34)),
                ..Described::default()
            },
        );
        let result = hit_test_via(
            &mut world,
            &el("/target"),
            &el("/frame"),
            (310, 154),
            Deadline::after(5_000).unwrap(),
        );
        let error = result.expect_err("an ancestor's overlapping sibling leaves delivery unproven");
        assert_eq!(error.code, ErrorCode::ActionFailed);
        assert_eq!(error.disposition, DeliverySemantics::not_delivered());
        assert!(error.suggestion.as_deref().unwrap().contains("overlap"));

        for extents in [
            rect(500, 500, 40, 20),
            rect(0, 0, 0, 0),
            rect(i32::MIN, i32::MIN, 420, 34),
        ] {
            world
                .nodes
                .described
                .get_mut("/other")
                .unwrap()
                .window_extents = Some(extents);
            assert_eq!(test(&mut world, (310, 154)), HitTestResult::ReachesTarget);
        }
        world
            .nodes
            .child_lists
            .insert("/pane".to_owned(), vec!["/target".to_owned()]);
        world.nodes.parent("/target", "/wrong_parent");
        assert_eq!(test(&mut world, (310, 154)), HitTestResult::ReachesTarget);
        world
            .nodes
            .described
            .get_mut("/other")
            .unwrap()
            .window_extents = None;
        let error = hit_test_via(
            &mut world,
            &el("/target"),
            &el("/frame"),
            (310, 154),
            Deadline::after(5_000).unwrap(),
        )
        .expect_err("unreadable sibling bounds cannot prove a clear point");
        assert_eq!(error.details.unwrap()["reason"], "child_bounds_unknown");
    }
}
