use crate::{fixture::Fixture, fixture_node::FixtureNode, scenario::Scenario};
use agent_desktop_core::{ContainmentPredicate, IdentityPredicate, LocatorQuery, Rect, WindowInfo};

const MOVING_FRAMES: usize = 11;

pub(crate) fn all() -> Vec<Scenario> {
    vec![
        deep_anonymous_containment(),
        duplicate_role_and_name(),
        electron_dual_identifier_moving_bounds(),
        large_electron_channel_tree(),
    ]
}

fn deep_anonymous_containment() -> Scenario {
    let fixture = chain_fixture(64, 48);
    Scenario {
        name: "deep_anonymous_has_text",
        frames: vec![fixture],
        query: LocatorQuery {
            identity: IdentityPredicate {
                role: Some("group".into()),
                name: Some("layer".into()),
                ..IdentityPredicate::default()
            },
            has_text: Some("needle".into()),
            ..LocatorQuery::default()
        },
        expected_matches: 64 * 24,
    }
}

fn duplicate_role_and_name() -> Scenario {
    let fixture = button_fixture(0, false);
    Scenario {
        name: "duplicate_button_role_and_name",
        frames: vec![fixture],
        query: LocatorQuery {
            identity: IdentityPredicate {
                role: Some("button".into()),
                name: Some("send".into()),
                ..IdentityPredicate::default()
            },
            exact: true,
            ..LocatorQuery::default()
        },
        expected_matches: 512,
    }
}

fn electron_dual_identifier_moving_bounds() -> Scenario {
    let frames = (0..MOVING_FRAMES)
        .map(|frame| button_fixture(frame, true))
        .collect();
    Scenario {
        name: "electron_dual_identifier_moving_bounds",
        frames,
        query: LocatorQuery {
            identity: IdentityPredicate {
                role: Some("button".into()),
                native_id: Some("composer-send".into()),
                ..IdentityPredicate::default()
            },
            ..LocatorQuery::default()
        },
        expected_matches: 1,
    }
}

fn large_electron_channel_tree() -> Scenario {
    let fixture = channel_fixture(640, 8);
    Scenario {
        name: "large_nested_channel_has_unread",
        frames: vec![fixture],
        query: LocatorQuery {
            identity: IdentityPredicate {
                role: Some("group".into()),
                name: Some("channel".into()),
                ..IdentityPredicate::default()
            },
            containment: ContainmentPredicate {
                has: Some(Box::new(LocatorQuery {
                    identity: IdentityPredicate {
                        name: Some("unread".into()),
                        ..IdentityPredicate::default()
                    },
                    exact: true,
                    ..LocatorQuery::default()
                })),
                has_not: None,
            },
            exact: true,
            ..LocatorQuery::default()
        },
        expected_matches: 10,
    }
}

fn chain_fixture(chains: usize, depth: usize) -> Fixture {
    let mut nodes = vec![node("group", Some("Electron Root"), 0.0, Vec::new())];
    for chain in 0..chains {
        let root = push(
            &mut nodes,
            node("group", Some("Layer"), chain as f64, Vec::new()),
        );
        nodes[0].children.push(root);
        let mut parent = root;
        for level in 1..depth {
            let name = (level % 2 == 0).then_some("Layer");
            let child = push(
                &mut nodes,
                node("group", name, (chain * depth + level) as f64, Vec::new()),
            );
            nodes[parent as usize].children.push(child);
            parent = child;
        }
        let needle = push(
            &mut nodes,
            node("statictext", Some("Needle"), chain as f64, Vec::new()),
        );
        nodes[parent as usize].children.push(needle);
    }
    Fixture {
        nodes,
        roots: vec![0],
        window: window(),
    }
}

fn button_fixture(frame: usize, dual_identifier: bool) -> Fixture {
    let mut nodes = vec![node("group", Some("Composer"), 0.0, Vec::new())];
    let target_position = frame * 37 % 512;
    for position in 0..512 {
        let logical = if position == target_position {
            0
        } else {
            position + 1
        };
        let identifiers = if position == target_position && dual_identifier {
            (
                Some("AXNode-8842".to_string()),
                Some("composer-send".to_string()),
            )
        } else {
            (
                Some(format!("AXNode-{logical}")),
                Some(format!("send-{logical}")),
            )
        };
        let bounds = Rect {
            x: (position % 32) as f64 * 18.0 + frame as f64 * 0.75,
            y: (position / 32) as f64 * 22.0 + frame as f64 * 1.25,
            width: 16.0,
            height: 20.0,
        };
        let child = push(
            &mut nodes,
            FixtureNode::new("button", Some("Send"), identifiers, bounds, Vec::new()),
        );
        nodes[0].children.push(child);
    }
    Fixture {
        nodes,
        roots: vec![0],
        window: window(),
    }
}

fn channel_fixture(channels: usize, wrapper_depth: usize) -> Fixture {
    let mut nodes = vec![node("group", Some("Slack"), 0.0, Vec::new())];
    for channel in 0..channels {
        let row = push(
            &mut nodes,
            node("group", Some("Channel"), channel as f64, Vec::new()),
        );
        nodes[0].children.push(row);
        let mut parent = row;
        for wrapper in 0..wrapper_depth {
            let child = push(
                &mut nodes,
                node(
                    "group",
                    None,
                    (channel * wrapper_depth + wrapper) as f64,
                    Vec::new(),
                ),
            );
            nodes[parent as usize].children.push(child);
            parent = child;
        }
        let label = (channel % 64 == 0).then_some("Unread");
        let text = push(
            &mut nodes,
            node("statictext", label, channel as f64, Vec::new()),
        );
        nodes[parent as usize].children.push(text);
    }
    Fixture {
        nodes,
        roots: vec![0],
        window: window(),
    }
}

fn node(role: &str, name: Option<&str>, offset: f64, children: Vec<u32>) -> FixtureNode {
    FixtureNode::new(
        role,
        name,
        (None, None),
        Rect {
            x: offset % 1200.0,
            y: offset % 800.0,
            width: 100.0,
            height: 24.0,
        },
        children,
    )
}

fn push(nodes: &mut Vec<FixtureNode>, node: FixtureNode) -> u32 {
    let index = nodes.len() as u32;
    nodes.push(node);
    index
}

fn window() -> WindowInfo {
    WindowInfo {
        id: "w-electron-benchmark".into(),
        title: "Electron Benchmark".into(),
        app: "SyntheticElectron".into(),
        pid: agent_desktop_core::ProcessId::new(4242),
        process_instance: Some("benchmark-4242".into()),
        bounds: None,
        state: agent_desktop_core::WindowState {
            is_focused: true,
            ..Default::default()
        },
    }
}
