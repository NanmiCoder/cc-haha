use super::*;
use crate::system::x11::stacking::stacked_window::StackedWindow;
use crate::system::x11::window::desktop_placement::DesktopPlacement;
use crate::system::x11::window::window_flags::WindowFlags;
use crate::system::x11::window::window_kind::WindowKind;
use crate::system::x11::{FrameExtents, X11Client};
use crate::tree::hit_test::hit_descent::Described;
use crate::tree::hit_test::hit_descent::tests::{FakeNodes, el};

const CLIENT: u32 = 10;

pub(crate) fn rect(x: i32, y: i32, width: i32, height: i32) -> Extents {
    Extents {
        x,
        y,
        width,
        height,
    }
}

fn toolkit(name: &str, version: &str) -> ToolkitId {
    ToolkitId {
        name: Some(name.to_owned()),
        version: Some(version.to_owned()),
    }
}

fn frame_facts() -> FrameFacts {
    FrameFacts {
        size_identity: false,
        pid: 1,
        title: "Terminal".to_owned(),
        extents: None,
        global_position: true,
    }
}

fn gtk3_facts() -> Facts {
    Facts {
        screen: rect(100, 137, 420, 34),
        window: rect(0, 0, 420, 34),
        frame: frame_facts(),
        minimized: false,
        toolkit: toolkit("gtk", "3.24.41"),
    }
}

fn gtk4_facts() -> Facts {
    Facts {
        screen: rect(0, 0, 558, 54),
        window: rect(329, 285, 558, 54),
        frame: frame_facts(),
        minimized: false,
        toolkit: toolkit("gtk", "4.14.5"),
    }
}

pub(crate) fn stacked(id: u32, client: Extents) -> StackedWindow {
    StackedWindow {
        shadow: (0, 0, 0, 0),
        id,
        flags: WindowFlags {
            hidden: false,
            above: false,
            mapped: true,
        },
        desktop: DesktopPlacement::On(0),
        kind: WindowKind::Normal,
        client,
        extents: FrameExtents {
            left: 0,
            right: 0,
            top: 0,
            bottom: 0,
        },
    }
}

pub(crate) fn windowing(origin: (i32, i32), above: Vec<StackedWindow>) -> Windowing {
    let mut stack = vec![stacked(CLIENT, rect(origin.0, origin.1, 800, 600))];
    stack.extend(above);
    Windowing {
        descent_root: None,
        coordinate_origin: None,
        client: CLIENT,
        snapshot: StackingSnapshot {
            current_desktop: Some(0),
            stack,
            override_redirect_above: Vec::new(),
            override_redirect_receiving: Vec::new(),
            override_redirect_names: Vec::new(),
        },
        clients: Vec::new(),
    }
}

fn client(id: u32, pid: u32, title: &str) -> X11Client {
    X11Client {
        shadow: (0, 0, 0, 0),
        id,
        hidden: false,
        pid: Some(pid),
        title: title.to_owned(),
        extents: None,
        bounds: None,
    }
}

struct World {
    nodes: FakeNodes,
    facts: Option<Facts>,
    windowing: Option<Windowing>,
}

impl World {
    fn new(facts: Facts, windowing: Option<Windowing>) -> Self {
        let mut nodes = FakeNodes::default();
        nodes
            .parent("/pane", "/frame")
            .parent("/target", "/pane")
            .parent("/other", "/frame");
        for (path, extents) in [
            ("/pane", rect(0, 0, 1000, 1000)),
            ("/target", facts.window),
            ("/other", rect(700, 700, 40, 20)),
        ] {
            nodes.described.insert(
                path.to_owned(),
                Described {
                    window_extents: Some(extents),
                    ..Described::default()
                },
            );
        }
        Self {
            nodes,
            facts: Some(facts),
            windowing,
        }
    }
}

impl HitWorld for World {
    fn nodes(&mut self) -> &mut impl NodeSource {
        &mut self.nodes
    }

    fn facts(
        &mut self,
        _target: &AtspiElement,
        _frame: &AtspiElement,
    ) -> Result<Option<Facts>, AdapterError> {
        Ok(self.facts.clone())
    }

    fn windowing(&mut self, _frame: &FrameFacts) -> Option<Windowing> {
        self.windowing.clone()
    }
}

fn test(world: &mut World, point: (i32, i32)) -> HitTestResult {
    let deadline = Deadline::after(5_000).expect("a deadline builds");
    hit_test_via(world, &el("/target"), &el("/frame"), point, deadline).expect("no timeout")
}

fn reaching(world: &mut World) {
    world
        .nodes
        .lead("/frame", "/pane")
        .lead("/pane", "/target")
        .lead("/target", "/target");
}

fn reachable(facts: Facts, origin: (i32, i32), above: Vec<StackedWindow>) -> World {
    let mut world = World::new(facts, Some(windowing(origin, above)));
    reaching(&mut world);
    world
}

fn unknown(world: &mut World, point: (i32, i32)) {
    assert_eq!(test(world, point), HitTestResult::Unknown);
}

#[test]
fn a_window_above_the_target_over_the_point_intercepts_without_a_descent() {
    let cover = stacked(20, rect(200, 100, 600, 400));
    let mut world = reachable(gtk3_facts(), (100, 137), vec![cover]);
    let HitTestResult::InterceptedBy { role, name, bounds } = test(&mut world, (310, 154)) else {
        panic!("a cover must intercept");
    };
    assert_eq!(role.as_deref(), Some("window"));
    assert_eq!(name, None);
    assert_eq!(bounds.expect("the cover's frame").width, 600.0);
}

#[test]
fn cover_names_require_unique_identity() {
    let cover = stacked(20, rect(200, 100, 600, 400));
    for (clients, expected) in [
        (vec![], None),
        (vec![client(20, 77, "Cover")], Some("Cover")),
        (
            vec![client(20, 77, "Cover"), client(21, 77, "Other")],
            Some("Cover"),
        ),
        (vec![client(20, 77, "Cover"), client(21, 77, "Cover")], None),
        (
            vec![client(20, 77, "Cover"), client(21, 78, "Cover")],
            Some("Cover"),
        ),
        (vec![client(20, 77, "")], None),
    ] {
        let mut covered = windowing((100, 137), vec![cover.clone()]);
        covered.clients = clients;
        let mut world = World::new(gtk3_facts(), Some(covered));
        assert!(
            matches!(test(&mut world, (310, 154)), HitTestResult::InterceptedBy { name, .. } if name.as_deref() == expected)
        );
    }

    for (names, expected) in [
        (vec![(30, "Popup".to_owned())], Some("Popup")),
        (vec![(31, "Popup".to_owned())], None),
        (
            vec![(30, "Popup".to_owned()), (31, "Popup".to_owned())],
            None,
        ),
    ] {
        let mut stacking = windowing((100, 137), vec![]);
        stacking.snapshot.override_redirect_above = vec![rect(200, 100, 600, 400)];
        stacking.snapshot.override_redirect_receiving = vec![(30, rect(200, 100, 600, 400))];
        stacking.snapshot.override_redirect_names = names;
        let mut world = World::new(gtk3_facts(), Some(stacking));
        assert!(
            matches!(test(&mut world, (310, 154)), HitTestResult::InterceptedBy { name, .. } if name.as_deref() == expected)
        );
    }

    let mut stacking = windowing((100, 137), vec![]);
    stacking.snapshot.override_redirect_above = vec![rect(200, 100, 600, 400)];
    stacking.snapshot.override_redirect_receiving = vec![(30, rect(200, 100, 600, 400))];
    stacking.snapshot.override_redirect_names = vec![(30, "Popup".to_owned())];
    stacking.clients = vec![client(20, 77, "Popup")];
    let mut world = World::new(gtk3_facts(), Some(stacking));
    assert!(matches!(
        test(&mut world, (310, 154)),
        HitTestResult::InterceptedBy { name: None, .. }
    ));
}

#[test]
fn the_cross_window_leg_is_what_separates_reaches_from_intercepted() {
    for (name, version) in [("gtk", "3.24.41"), ("Qt", "6.10"), ("Chromium", "1.0")] {
        let mut facts = gtk3_facts();
        facts.toolkit = toolkit(name, version);
        let covered = stacked(20, rect(200, 100, 600, 400));
        let mut world = reachable(facts.clone(), (100, 137), vec![covered]);
        let result = test(&mut world, (310, 154));
        assert!(matches!(result, HitTestResult::InterceptedBy { .. }));
        let mut raised = reachable(facts, (100, 137), vec![]);
        assert_eq!(test(&mut raised, (310, 154)), HitTestResult::ReachesTarget);
        assert_eq!(raised.nodes.points.first(), Some(&(210, 17)));
    }
}

#[test]
fn a_cover_that_misses_the_point_leaves_the_target_reachable() {
    let aside = stacked(20, rect(700, 700, 50, 50));
    let mut world = reachable(gtk3_facts(), (100, 137), vec![aside]);
    assert_eq!(test(&mut world, (310, 154)), HitTestResult::ReachesTarget);
}

#[test]
fn unknown_inputs_stay_unknown() {
    let mut world = World::new(gtk3_facts(), Some(windowing((100, 137), vec![])));
    world.nodes.lead("/frame", "/pane");
    unknown(&mut world, (310, 154));
    world.nodes.endless = true;
    unknown(&mut world, (310, 154));
    world.nodes.endless = false;
    reaching(&mut world);
    world
        .windowing
        .as_mut()
        .unwrap()
        .snapshot
        .override_redirect_above = vec![rect(300, 150, 50, 50)];
    unknown(&mut world, (310, 154));

    let mut unavailable = reachable(gtk3_facts(), (100, 137), vec![]);
    unavailable.windowing = None;
    unknown(&mut unavailable, (310, 154));
    unavailable.windowing = Some(windowing((400, 300), vec![]));
    unknown(&mut unavailable, (310, 154));
    unavailable.facts = None;
    unknown(&mut unavailable, (310, 154));

    let mut blind_facts = gtk3_facts();
    blind_facts.toolkit = toolkit("Other", "1.0");
    let mut blind = reachable(
        blind_facts,
        (100, 137),
        vec![stacked(20, rect(200, 100, 600, 400))],
    );
    blind.nodes.lead("/frame", "/other");
    blind.nodes.described.insert(
        "/other".to_owned(),
        Described {
            window_extents: Some(rect(200, 10, 40, 20)),
            ..Described::default()
        },
    );
    unknown(&mut blind, (310, 154));

    let mut gtk4_missing = reachable(gtk4_facts(), (302, 260), vec![]);
    gtk4_missing.windowing = None;
    unknown(&mut gtk4_missing, (700, 560));
    let mut raw_only = reachable(gtk4_facts(), (302, 260), vec![]);
    unknown(&mut raw_only, (10, 10));
    let mut gtk3_stops_above = World::new(gtk3_facts(), Some(windowing((100, 137), vec![])));
    gtk3_stops_above.nodes.lead("/frame", "/pane");
    unknown(&mut gtk3_stops_above, (310, 154));
    let mut gtk4_lander = reachable(gtk4_facts(), (302, 260), vec![]);
    gtk4_lander.nodes.lead("/frame", "/other");
    unknown(&mut gtk4_lander, (700, 560));

    let mut minimized_facts = gtk3_facts();
    minimized_facts.minimized = true;
    unknown(
        &mut reachable(minimized_facts, (100, 137), vec![]),
        (310, 154),
    );
    for screen in [
        rect(0, 0, 710, 0),
        rect(i32::MIN, i32::MIN, 100, 100),
        rect(-1, -1, -1, -1),
    ] {
        let mut facts = gtk3_facts();
        facts.screen = screen;
        unknown(&mut reachable(facts, (100, 137), vec![]), (0, 0));
    }
    unknown(&mut reachable(gtk3_facts(), (100, 137), vec![]), (560, 154));
    let mut unreadable = reachable(gtk3_facts(), (100, 137), vec![]);
    unreadable.facts = None;
    unknown(&mut unreadable, (310, 154));
}

#[test]
fn calibrated_points_reach_or_intercept_at_the_calibrated_position() {
    let mut gtk3 = reachable(gtk3_facts(), (100, 137), vec![]);
    assert_eq!(test(&mut gtk3, (310, 154)), HitTestResult::ReachesTarget);
    assert_eq!(gtk3.nodes.points.first(), Some(&(210, 17)));
    let mut gtk4 = reachable(gtk4_facts(), (302, 260), vec![]);
    assert_eq!(test(&mut gtk4, (700, 560)), HitTestResult::ReachesTarget);
    assert_eq!(gtk4.nodes.points.first(), Some(&(398, 300)));
    let cover = stacked(20, rect(500, 400, 800, 400));
    let mut covered = reachable(gtk4_facts(), (302, 260), vec![cover]);
    assert!(matches!(
        test(&mut covered, (700, 560)),
        HitTestResult::InterceptedBy { .. }
    ));
}

#[path = "hit_test_shadow_tests.rs"]
mod shadow;

#[path = "hit_test_popup_tests.rs"]
mod popup;

#[path = "hit_test_overlap_tests.rs"]
mod overlap;

#[test]
fn a_gtk4_point_query_that_stops_at_a_container_reaches_the_target() {
    let mut stops_above = World::new(gtk4_facts(), Some(windowing((302, 260), vec![])));
    stops_above.nodes.lead("/frame", "/pane");
    assert_eq!(
        test(&mut stops_above, (700, 560)),
        HitTestResult::ReachesTarget
    );
}

#[test]
fn a_gtk4_landing_outside_the_walked_tree_reaches_the_target_and_a_gtk3_one_does_not() {
    let unlisted = |facts, origin| {
        let mut world = World::new(facts, Some(windowing(origin, vec![])));
        world.nodes.lead("/frame", "/other");
        world.nodes.parents.remove("/other");
        world
    };
    let mut gtk4 = unlisted(gtk4_facts(), (302, 260));
    assert_eq!(test(&mut gtk4, (700, 560)), HitTestResult::ReachesTarget);
    let mut gtk3 = unlisted(gtk3_facts(), (100, 137));
    unknown(&mut gtk3, (310, 154));
}
