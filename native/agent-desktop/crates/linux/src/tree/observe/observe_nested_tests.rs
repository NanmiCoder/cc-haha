use agent_desktop_core::{AdapterError, Deadline, ErrorCode, ObservationRoot, SnapshotSurface};

use super::tests::{observe_plain, request, rooted_walk, window};
use crate::system::window::window_id;
use crate::tree::live::test_support::{read_of, words};
use crate::tree::walk::walker::walk_levels;
use crate::tree::walk::wrapper::classify;
use crate::tree::{AtspiElement, Expansion, Field, ObservedRead, Walk, WalkLimits};

fn window_holding_an_alert_below(
    panes: u32,
) -> impl Fn(&WalkLimits) -> Result<Walk<ObservedRead>, AdapterError> {
    move |limits| {
        walk_levels(
            0u32,
            limits,
            Deadline::after(5_000).expect("deadline"),
            |level| {
                Ok(level
                    .iter()
                    .map(|key| match *key {
                        0 => {
                            let mut frame = read_of(23, "w", &[]);
                            frame.node.traits.states = Field::Present(words(&[25]));
                            Expansion::read(frame, vec![1u32])
                        }
                        key if key <= panes => {
                            Expansion::read(read_of(39, "pane", &[]), vec![key + 1])
                        }
                        _ => {
                            let mut alert = read_of(2, "Save Changes?", &[]);
                            alert.node.element = AtspiElement::new(":1.7", "/d", 77);
                            alert.node.traits.states = Field::Present(words(&[25]));
                            Expansion::read(alert, Vec::new())
                        }
                    })
                    .collect())
            },
            classify,
        )
    }
}

fn window_holding_a_dialog(
    showing: bool,
) -> impl Fn(&WalkLimits) -> Result<Walk<ObservedRead>, AdapterError> {
    move |limits| {
        walk_levels(
            0u32,
            limits,
            Deadline::after(5_000).expect("deadline"),
            |level| {
                Ok(level
                    .iter()
                    .map(|key| {
                        if *key == 0 {
                            let mut frame = read_of(23, "w", &[]);
                            frame.node.traits.states = Field::Present(words(&[25]));
                            Expansion::read(frame, vec![1u32])
                        } else {
                            let mut dialog = read_of(16, "", &[]);
                            dialog.node.element = AtspiElement::new(":1.7", "/d", 77);
                            let bits: &[u32] = if showing { &[25] } else { &[] };
                            dialog.node.traits.states = Field::Present(words(bits));
                            Expansion::read(dialog, Vec::new())
                        }
                    })
                    .collect())
            },
            classify,
        )
    }
}

#[test]
fn a_sheet_surface_roots_at_a_dialog_drawn_inside_the_window() {
    let id = window_id::encode(":1.7", "/a").expect("encodes");
    let window = window(id);
    let mut sheet = request();
    sheet.surface = SnapshotSurface::Sheet;
    let holding = window_holding_a_dialog(true);
    let dialog_walk = rooted_walk(16, &[25]);
    let mut rooted_at = Vec::new();
    let tree = observe_plain(
        ObservationRoot::Window(&window),
        &sheet,
        |element, limits, _| {
            rooted_at.push(element.path().to_owned());
            if element.path() == "/a" {
                holding(limits)
            } else {
                dialog_walk(limits)
            }
        },
    )
    .expect("the nested dialog observes as the sheet");
    assert!(tree.is_complete());
    assert_eq!(rooted_at, ["/a", "/d"]);
}

#[test]
fn an_alert_below_the_depth_the_request_asks_for_is_still_the_sheet() {
    let window = window(window_id::encode(":1.7", "/a").expect("encodes"));
    let mut sheet = request();
    sheet.surface = SnapshotSurface::Sheet;
    sheet.max_logical_depth = 2;
    let holding = window_holding_an_alert_below(4);
    let alert_walk = rooted_walk(2, &[25]);
    let mut rooted_at = Vec::new();
    let tree = observe_plain(
        ObservationRoot::Window(&window),
        &sheet,
        |element, limits, _| {
            rooted_at.push(element.path().to_owned());
            if element.path() == "/a" {
                holding(limits)
            } else {
                alert_walk(limits)
            }
        },
    )
    .expect("the alert below the request's depth is the sheet");
    assert!(tree.is_complete());
    assert_eq!(rooted_at, ["/a", "/a", "/d"]);
}

#[test]
fn a_dialog_inside_the_window_that_does_not_show_is_no_sheet() {
    let id = window_id::encode(":1.7", "/a").expect("encodes");
    let window = window(id);
    let mut sheet = request();
    sheet.surface = SnapshotSurface::Sheet;
    let holding = window_holding_a_dialog(false);
    let error = observe_plain(ObservationRoot::Window(&window), &sheet, |_, limits, _| {
        holding(limits)
    })
    .expect_err("a hidden dialog is not a sheet");
    assert_eq!(error.code, ErrorCode::ElementNotFound);
}

#[test]
fn multiple_nested_sheets_are_ambiguous_before_any_refs_are_published() {
    let window = window(window_id::encode(":1.7", "/a").unwrap());
    let mut sheet = request();
    sheet.surface = SnapshotSurface::Sheet;
    let error = observe_plain(
        ObservationRoot::Window(&window),
        &sheet,
        |element, limits, _| {
            assert_eq!(
                element.path(),
                "/a",
                "neither ambiguous dialog may be observed"
            );
            let mut walk = window_holding_a_dialog(true)(limits)?;
            let mut second = walk.root.children[0].clone();
            second.payload.node.element = AtspiElement::new(":1.7", "/other", 77);
            walk.root.children.push(second);
            walk.node_count += 1;
            Ok(walk)
        },
    )
    .expect_err("multiple sheets must not select an arbitrary dialog");
    assert_eq!(error.code, ErrorCode::AmbiguousTarget);
}

#[test]
fn unread_sheet_discovery_never_claims_absence_or_uniqueness() {
    let window = window(window_id::encode(":1.7", "/a").unwrap());
    let mut sheet = request();
    sheet.surface = SnapshotSurface::Sheet;
    for (showing, logical_cut) in [(false, false), (true, false), (false, true)] {
        let error = observe_plain(
            ObservationRoot::Window(&window),
            &sheet,
            |element, limits, _| {
                assert_eq!(
                    element.path(),
                    "/a",
                    "an unread region may hold another dialog"
                );
                let mut walk = window_holding_a_dialog(showing)(limits)?;
                if logical_cut {
                    walk.root.child_count = Some(1);
                    walk.root.children.clear();
                } else {
                    walk.complete = false;
                    walk.root.children[0].truncated = true;
                }
                Ok(walk)
            },
        )
        .expect_err("unread regions cannot settle sheet discovery");
        assert_eq!(error.code, ErrorCode::Timeout);
    }
}

#[test]
fn unread_sheet_role_or_state_never_proves_absence_or_uniqueness() {
    let window = window(window_id::encode(":1.7", "/a").unwrap());
    let mut sheet = request();
    sheet.surface = SnapshotSurface::Sheet;
    for unread_role in [true, false] {
        for (sibling, location) in [
            (false, "candidate"),
            (true, "candidate"),
            (false, "ancestor"),
            (false, "root"),
        ] {
            let error = observe_plain(
                ObservationRoot::Window(&window),
                &sheet,
                |element, limits, _| {
                    assert_eq!(element.path(), "/a", "uniqueness is not established");
                    let mut walk = window_holding_a_dialog(true)(limits)?;
                    if sibling {
                        let mut other = walk.root.children[0].clone();
                        other.payload.node.element = AtspiElement::new(":1.7", "/other", 77);
                        walk.root.children.push(other);
                        walk.node_count += 1;
                    }
                    if location == "ancestor" {
                        let mut outer = walk.root.children[0].clone();
                        outer.payload.node.element = AtspiElement::new(":1.7", "/outer", 77);
                        outer.children = std::mem::take(&mut walk.root.children);
                        walk.root.children.push(outer);
                        walk.node_count += 1;
                    }
                    let traits = if location == "root" {
                        &mut walk.root.payload.node.traits
                    } else {
                        &mut walk.root.children[0].payload.node.traits
                    };
                    if unread_role {
                        traits.role = Field::Failed("unread role".into());
                    } else {
                        traits.states = Field::Failed("unread state".into());
                    }
                    Ok(walk)
                },
            )
            .expect_err("unknown dialog evidence must refuse sheet discovery");
            assert_eq!(error.code, ErrorCode::Timeout);
        }
    }
}

#[test]
#[ignore = "drives GTK; run through scripts/private-session.sh --wm"]
fn live_sheet_discovery_refuses_unread_fields_while_the_dialog_remains_present() {
    use crate::tree::live::physical_live_rig::{Kit, Scene};
    use crate::tree::{WalkedNode, surfaces::nested_dialog};

    fn invalidate(node: &mut WalkedNode<ObservedRead>, path: &str, role: bool) {
        if node.payload.node.element.path() == path {
            if role {
                node.payload.node.traits.role = Field::Failed("unread role".into());
            } else {
                node.payload.node.traits.states = Field::Failed("unread showing state".into());
            }
        }
        for child in &mut node.children {
            invalidate(child, path, role);
        }
    }

    let scene = Scene::open(Kit::Gtk, crate::tree::live::sheet_live_tests::APP, 6);
    let mut window = window(window_id::encode(scene.frame.bus_name(), scene.frame.path()).unwrap());
    window.pid = scene.pid.into();
    let mut sheet = request();
    sheet.surface = SnapshotSurface::Sheet;
    for unread_role in [true, false] {
        sheet.deadline = Deadline::after(10_000).unwrap();
        let error = observe_plain(
            ObservationRoot::Window(&window),
            &sheet,
            |element, limits, deadline| {
                assert_eq!(
                    element.path(),
                    scene.frame.path(),
                    "unread sheet selection must refuse"
                );
                let mut walk =
                    crate::tree::walk::walker::walk_tree(&scene.bus, element, limits, deadline)?;
                assert!(walk.complete);
                let dialogs = nested_dialog::find(&walk.root);
                assert_eq!(dialogs.len(), 1);
                let path = dialogs[0].element.path().to_owned();
                invalidate(&mut walk.root, &path, unread_role);
                Ok(walk)
            },
        )
        .expect_err("field failure cannot prove a unique live sheet");
        assert_eq!(error.code, ErrorCode::Timeout);
        sheet.deadline = Deadline::after(10_000).unwrap();
        assert!(
            super::observe_tree(&scene.bus, ObservationRoot::Window(&window), &sheet)
                .unwrap()
                .is_complete()
        );
    }
    let output = std::process::Command::new("python3").args([
        "-c",
        "import gi,sys; gi.require_version('Atspi','2.0'); from gi.repository import Atspi\ndef nodes(n):\n yield n\n for i in range(n.get_child_count()): yield from nodes(n.get_child_at_index(i))\nd=Atspi.get_desktop(0); apps=[d.get_child_at_index(i) for i in range(d.get_child_count())]; a=next(a for a in apps if a.get_process_id()==int(sys.argv[1])); ds=[n for n in nodes(a) if n.get_role()==Atspi.Role.DIALOG and n.get_name()=='Sheet']; assert len(ds)==1; assert ds[0].get_state_set().contains(Atspi.StateType.SHOWING)",
        &scene.pid.to_string(),
    ]).output().expect("independent AT-SPI observer");
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
}

#[test]
fn alert_surface_finds_nested_alerts_and_rejects_ordinary_dialogs() {
    let window = window(window_id::encode(":1.7", "/a").unwrap());
    let mut request = request();
    request.surface = SnapshotSurface::Alert;
    for (role, showing, expected) in [
        (2, true, None),
        (2, false, Some(ErrorCode::ElementNotFound)),
        (16, true, Some(ErrorCode::ElementNotFound)),
    ] {
        let mut roots = Vec::new();
        let result = observe_plain(
            ObservationRoot::Window(&window),
            &request,
            |element, limits, _| {
                roots.push(element.path().to_owned());
                if element.path() == "/a" {
                    let mut walk = window_holding_a_dialog(showing)(limits)?;
                    walk.root.children[0].payload.node.traits.role = Field::Present(role);
                    Ok(walk)
                } else {
                    rooted_walk(role, &[25])(limits)
                }
            },
        );
        if let Some(code) = expected {
            assert_eq!(result.unwrap_err().code, code);
            assert_eq!(roots, ["/a"]);
        } else {
            assert!(result.unwrap().is_complete());
            assert_eq!(roots, ["/a", "/d"]);
        }
    }
}
