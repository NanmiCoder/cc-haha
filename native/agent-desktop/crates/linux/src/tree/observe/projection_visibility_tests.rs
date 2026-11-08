use super::*;
use crate::tree::element::ancestry;
use crate::tree::live::test_support::{read_of, words};
use crate::tree::live_read::live_project::live_state;
use crate::tree::vocabulary::role_numbers::{FRAME, PUSH_BUTTON, SCROLL_PANE};
use crate::tree::vocabulary::state_bits::{ICONIFIED, SHOWING, VISIBLE};
use crate::tree::{AtspiElement, WalkCounts};

fn rect(x: i32, y: i32, width: i32, height: i32) -> Extents {
    Extents {
        x,
        y,
        width,
        height,
    }
}

fn walked(
    payload: ObservedRead,
    children: Vec<WalkedNode<ObservedRead>>,
) -> WalkedNode<ObservedRead> {
    WalkedNode {
        payload,
        children,
        truncated: false,
        child_count: None,
        source_index: 0,
        in_web_document: false,
    }
}

fn visibility(tokens: &[String]) -> Vec<&str> {
    tokens
        .iter()
        .map(String::as_str)
        .filter(|token| matches!(*token, "hidden" | "offscreen"))
        .collect()
}

#[test]
fn popup_rows_are_not_clipped_to_their_menu_anchor() {
    use crate::tree::vocabulary::role_numbers::{MENU, MENU_ITEM};

    for (role, expected) in [(MENU, vec![]), (FRAME, vec!["offscreen"])] {
        let mut anchor = read_of(role, "File", &[]);
        anchor.node.element = AtspiElement::new(":1.1", "/anchor", 1);
        anchor
            .node
            .element
            .set_ancestry(ancestry::of_root(&anchor.node.element.clone()));
        anchor.node.extents = Field::Present(rect(100, 100, 40, 20));
        anchor.node.traits.states = Field::Present(words(&[VISIBLE, SHOWING]));
        let mut row = read_of(MENU_ITEM, "Save", &["click"]);
        row.node.element = AtspiElement::new(":1.1", "/save", 1);
        row.node
            .element
            .set_ancestry(ancestry::child(&anchor.node.element, Some(role)));
        row.node.extents = Field::Present(rect(100, 220, 200, 20));
        row.node.traits.states = Field::Present(words(&[VISIBLE, SHOWING]));
        let walk = Walk {
            root: walked(anchor, vec![walked(row, vec![])]),
            complete: true,
            node_count: 2,
            max_depth: 1,
            counts: WalkCounts::default(),
        };
        let snapshot = super::tests::tree_of(walk, &WalkLimits::default());
        assert_eq!(
            visibility(&snapshot.children[0].presentation.states),
            expected
        );
    }
}

#[test]
fn snapshot_and_live_visibility_agree_on_the_same_walk_facts() {
    let frame_rect = rect(0, 0, 200, 200);
    let inside = rect(40, 40, 20, 20);
    let sentinel = rect(i32::MIN, i32::MIN, 20, 20);
    for (bits, bounds, minimized, expected) in [
        (vec![VISIBLE], sentinel, false, vec!["offscreen"]),
        (vec![], sentinel, false, vec!["hidden"]),
        (vec![VISIBLE, SHOWING], inside, false, vec![]),
        (vec![VISIBLE], inside, false, vec![]),
        (vec![SHOWING], inside, false, vec![]),
        (
            vec![VISIBLE, SHOWING],
            rect(250, 40, 20, 20),
            false,
            vec!["offscreen"],
        ),
        (vec![VISIBLE, SHOWING], rect(210, 40, 20, 20), false, vec![]),
        (vec![VISIBLE, SHOWING], inside, true, vec!["offscreen"]),
        (vec![VISIBLE, SHOWING], sentinel, false, vec![]),
        (vec![], inside, false, vec!["hidden"]),
    ] {
        let mut frame = read_of(FRAME, "frame", &[]);
        frame.node.element = AtspiElement::new(":1.1", "/frame", 1);
        frame
            .node
            .element
            .set_ancestry(ancestry::of_root(&frame.node.element.clone()));
        frame.node.extents = Field::Present(frame_rect);
        frame.node.traits.states = Field::Present(words(if minimized {
            &[ICONIFIED]
        } else {
            &[VISIBLE, SHOWING]
        }));
        let role = if bits.is_empty() { 63 } else { PUSH_BUTTON };
        let mut button = read_of(role, "Save As...", &["click"]);
        button.node.element = AtspiElement::new(":1.1", "/button", 1);
        button
            .node
            .element
            .set_ancestry(ancestry::child(&frame.node.element, Some(FRAME)));
        button.node.extents = Field::Present(bounds);
        button.node.traits.states = Field::Present(words(&bits));
        let root = walked(frame, vec![walked(button.clone(), vec![])]);
        let walk = Walk {
            root,
            complete: true,
            node_count: 2,
            max_depth: 1,
            counts: WalkCounts::default(),
        };
        let snapshot = super::tests::tree_of(walk, &WalkLimits::default());
        let snapshot = &snapshot.children[0].presentation.states;
        let mut evidence = project_node(&button, false, &WalkLimits::default());
        evidence.states = resolve_vocabulary(&button.node, &button.label, false).states;
        let placed = Placement {
            node: Some(bounds),
            frame: Some(frame_rect),
            frame_iconified: Some(minimized),
            ..Placement::default()
        };
        let live = live_state(&button, &evidence, &placed).unwrap();
        assert_eq!(
            visibility(snapshot),
            expected,
            "bits={bits:?}, bounds={bounds:?}, minimized={minimized}"
        );
        assert_eq!(visibility(snapshot), visibility(&live.states));
    }
}

#[test]
fn snapshot_uses_retained_window_geometry_and_the_walked_scroll_container() {
    let mut frame = read_of(FRAME, "frame", &[]);
    frame.node.element = AtspiElement::new(":1.1", "/frame", 1);
    frame
        .node
        .element
        .set_ancestry(ancestry::of_root(&frame.node.element.clone()));
    frame.evidence_bounds = Some((
        rect(0, 0, 200, 200),
        agent_desktop_core::BoundsSpace::Window,
    ));
    let mut container = read_of(SCROLL_PANE, "scroll", &[]);
    container.node.element = AtspiElement::new(":1.1", "/scroll", 1);
    container
        .node
        .element
        .set_ancestry(ancestry::child(&frame.node.element, Some(FRAME)));
    container.evidence_bounds =
        Some((rect(0, 0, 200, 80), agent_desktop_core::BoundsSpace::Window));
    let mut button = read_of(PUSH_BUTTON, "row", &["click"]);
    button.node.element = AtspiElement::new(":1.1", "/button", 1);
    button
        .node
        .element
        .set_ancestry(ancestry::child(&container.node.element, Some(SCROLL_PANE)));
    button.node.traits.states = Field::Present(words(&[VISIBLE, SHOWING]));
    button.evidence_bounds = Some((
        rect(40, 120, 20, 20),
        agent_desktop_core::BoundsSpace::Window,
    ));
    let root = walked(frame, vec![walked(container, vec![walked(button, vec![])])]);
    let walk = Walk {
        root,
        complete: true,
        node_count: 3,
        max_depth: 2,
        counts: WalkCounts::default(),
    };
    let snapshot = super::tests::tree_of(walk, &WalkLimits::default());
    assert_eq!(
        visibility(&snapshot.children[0].children[0].presentation.states),
        ["offscreen"]
    );
}

#[test]
fn snapshot_and_live_agree_when_a_shown_node_is_beyond_every_display() {
    let display = [rect(0, 0, 1000, 600)];
    let bounds = rect(1, 664, 600, 63);
    for (displays, screen, expected) in [
        (Some(display.as_slice()), Some(bounds), vec!["offscreen"]),
        (None, Some(bounds), vec![]),
        (Some([].as_slice()), Some(bounds), vec![]),
        (Some(display.as_slice()), None, vec![]),
    ] {
        let mut frame = read_of(FRAME, "frame", &[]);
        frame.node.element = AtspiElement::new(":1.1", "/frame", 1);
        frame
            .node
            .element
            .set_ancestry(ancestry::of_root(&frame.node.element.clone()));
        frame.node.extents = Field::Present(rect(0, 0, 600, 900));
        frame.node.traits.states = Field::Present(words(&[VISIBLE, SHOWING]));
        let mut button = read_of(PUSH_BUTTON, "Open", &["click"]);
        button.node.element = AtspiElement::new(":1.1", "/button", 1);
        button
            .node
            .element
            .set_ancestry(ancestry::child(&frame.node.element, Some(FRAME)));
        button.node.traits.states = Field::Present(words(&[VISIBLE, SHOWING]));
        button.evidence_bounds = Some((bounds, agent_desktop_core::BoundsSpace::Window));
        button.node.extents =
            screen.map_or_else(|| Field::Failed("unplaced".into()), Field::Present);
        let walk = Walk {
            root: walked(frame, vec![walked(button.clone(), vec![])]),
            complete: true,
            node_count: 2,
            max_depth: 1,
            counts: WalkCounts::default(),
        };
        let (subtree, stats) = project_with(
            walk,
            &WalkLimits::default(),
            &mut crate::tree::observe::decorate::Plain,
            displays,
        );
        let window = agent_desktop_core::WindowInfo {
            id: "w-1.1-p".into(),
            title: "frame".into(),
            app: "fixture".into(),
            pid: 1.into(),
            process_instance: None,
            bounds: None,
            state: agent_desktop_core::WindowState::default(),
        };
        let snapshot = agent_desktop_core::ObservedTree::from_roots(
            vec![subtree],
            agent_desktop_core::ObservationSource::from_root(
                &agent_desktop_core::ObservationRoot::Window(&window),
                agent_desktop_core::SnapshotSurface::Window,
            ),
            stats,
            true,
        )
        .unwrap()
        .into_accessibility_tree_partial()
        .unwrap()
        .0;
        let placement = Placement {
            node: Some(bounds),
            frame: Some(rect(0, 0, 600, 900)),
            displays: displays.map(<[Extents]>::to_vec),
            toolkit: crate::system::process::toolkit_id::ToolkitId {
                name: Some("GTK".into()),
                version: Some("3.24".into()),
            },
            ..Placement::default()
        };
        let evidence = project_node(&button, false, &WalkLimits::default());
        let live = live_state(&button, &evidence, &placement).unwrap();
        assert_eq!(
            visibility(&snapshot.children[0].presentation.states),
            expected
        );
        assert_eq!(
            visibility(&snapshot.children[0].presentation.states),
            visibility(&live.states)
        );
    }
}
