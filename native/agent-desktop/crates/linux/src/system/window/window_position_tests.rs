use super::*;
use crate::system::process::process_facts::ProcessFacts;
use crate::system::process::toolkit_id::ToolkitId;
use crate::system::registry::registry_app::assemble;
use crate::system::window::window_listing::collect;
use crate::system::x11::window::desktops::Desktops;
use crate::tree::live::test_support::{read_of, words};
use crate::tree::{AtspiElement, Field};

fn twin_windows(active: &[bool]) -> Vec<ListedWindow> {
    let app = assemble(
        AtspiElement::new(":1.9", "/org/a11y/atspi/accessible/root", 321),
        ProcessFacts {
            executable: None,
            comm: "x".to_owned(),
            exe_basename: Some("x".to_owned()),
            instance: "boot:42".to_owned(),
        },
        Some(Some("App".to_owned())),
        ToolkitId {
            name: Some("gtk".to_owned()),
            version: Some("4.14.5".to_owned()),
        },
    );
    let nodes = active
        .iter()
        .enumerate()
        .map(|(index, active)| {
            let mut node = read_of(23, "Doc", &[]).node;
            node.element = AtspiElement::new(":1.9", format!("/frame/{index}"), 321);
            node.traits.interfaces =
                Field::Present(vec![crate::tree::COMPONENT_INTERFACE.to_owned()]);
            node.traits.states = Field::Present(words(if *active { &[25, 1] } else { &[25] }));
            node.extents = Field::Present(Extents {
                x: 0,
                y: 0,
                width: 10,
                height: 10,
            });
            node
        })
        .collect();
    collect(&[(0, &app)], &[nodes])
}

fn windows(toolkit: (&str, &str)) -> Vec<ListedWindow> {
    let app = assemble(
        AtspiElement::new(":1.9", "/org/a11y/atspi/accessible/root", 321),
        ProcessFacts {
            executable: None,
            comm: "x".to_owned(),
            exe_basename: Some("x".to_owned()),
            instance: "boot:42".to_owned(),
        },
        Some(Some("App".to_owned())),
        ToolkitId {
            name: Some(toolkit.0.to_owned()),
            version: Some(toolkit.1.to_owned()),
        },
    );
    let mut node = read_of(23, "Doc", &[]).node;
    node.element = AtspiElement::new(":1.9", "/org/a11y/atspi/accessible/1", 321);
    node.traits.interfaces = Field::Present(vec![crate::tree::COMPONENT_INTERFACE.to_owned()]);
    node.traits.states = Field::Present(words(&[25, 1]));
    collect(&[(0, &app)], &[vec![node]])
}

fn client(id: u32, x: i32, y: i32) -> X11Client {
    X11Client {
        shadow: (0, 0, 0, 0),
        id,
        hidden: false,
        pid: Some(321),
        title: "Doc".to_owned(),
        extents: None,
        bounds: Some(Extents {
            x,
            y,
            width: 10,
            height: 10,
        }),
    }
}

fn ready(clients: Vec<X11Client>) -> X11State {
    X11State::Ready {
        active: None,
        clients,
    }
}

#[test]
fn a_window_without_global_position_takes_the_origin_of_its_unique_client() {
    let mut listed = windows(("gtk", "4.14.5"));
    assert_eq!(listed[0].info.bounds, None);
    place_windows(&mut listed, &ready(vec![client(7, 460, 165)]), None);
    let bounds = listed[0].info.bounds.expect("a position");
    assert_eq!((bounds.x, bounds.y), (460.0, 165.0));
    assert_eq!((bounds.width, bounds.height), (10.0, 10.0));
}

#[test]
fn a_window_that_maps_to_two_clients_has_no_position() {
    let mut listed = windows(("gtk", "4.14.5"));
    place_windows(
        &mut listed,
        &ready(vec![client(7, 460, 165), client(8, 20, 20)]),
        None,
    );
    assert_eq!(listed[0].info.bounds, None);
}

#[test]
fn a_window_has_no_position_when_the_display_server_did_not_answer() {
    for state in [X11State::Unavailable, X11State::NoWindowManager] {
        let mut listed = windows(("gtk", "4.14.5"));
        place_windows(&mut listed, &state, None);
        assert_eq!(listed[0].info.bounds, None);
    }
}

#[test]
fn an_unreadable_toolkit_is_treated_as_having_no_global_position() {
    let mut listed = windows(("clutter", "1.0"));
    place_windows(&mut listed, &ready(vec![client(7, 300, 90)]), None);
    assert_eq!(listed[0].info.bounds.map(|rect| rect.x), Some(300.0));
}

#[test]
fn a_global_position_toolkit_keeps_the_extents_it_reported() {
    let mut listed = windows(("gtk", "3.24.41"));
    let reported = listed[0].info.bounds;
    assert!(reported.is_some());
    place_windows(&mut listed, &ready(vec![client(7, 460, 165)]), None);
    assert_eq!(listed[0].info.bounds, reported);
}

#[test]
fn a_hidden_client_marks_its_window_minimized_and_not_visible() {
    let mut listed = windows(("gtk", "4.14.5"));
    assert_eq!(listed[0].info.state.minimized, Some(false));
    let mut hidden = client(7, 460, 165);
    hidden.hidden = true;
    place_windows(&mut listed, &ready(vec![hidden]), None);
    assert_eq!(listed[0].info.state.minimized, Some(true));
    assert_eq!(listed[0].info.state.visible, Some(false));
}

#[test]
fn a_shown_client_or_a_silent_display_server_leaves_the_toolkit_state() {
    for state in [
        ready(vec![client(7, 460, 165)]),
        X11State::Unavailable,
        X11State::NoWindowManager,
    ] {
        let mut listed = windows(("gtk", "4.14.5"));
        place_windows(&mut listed, &state, None);
        assert_eq!(listed[0].info.state.minimized, Some(false));
        assert_eq!(listed[0].info.state.visible, Some(true));
    }
}

#[test]
fn a_window_that_maps_to_two_clients_is_not_marked_minimized() {
    let mut listed = windows(("gtk", "4.14.5"));
    let mut hidden = client(7, 460, 165);
    hidden.hidden = true;
    place_windows(&mut listed, &ready(vec![hidden, client(8, 20, 20)]), None);
    assert_eq!(listed[0].info.state.minimized, Some(false));
}

#[test]
fn a_gtk_window_with_a_client_side_shadow_is_placed_inside_the_shadow() {
    let mut shadowed = client(7, 37, 64);
    shadowed.shadow = (61, 55, 0, 0);
    let mut listed = windows(("gtk", "4.14.5"));

    place_windows(&mut listed, &ready(vec![shadowed]), None);

    let bounds = listed[0].info.bounds.expect("a position");
    assert_eq!((bounds.x, bounds.y), (98.0, 119.0));
}

#[test]
fn a_gtk_window_with_a_shadow_has_the_size_of_its_client_less_the_shadow() {
    let mut shadowed = client(7, 37, 79);
    shadowed.shadow = (61, 55, 61, 67);
    shadowed.bounds = Some(Extents {
        x: 37,
        y: 79,
        width: 542,
        height: 682,
    });
    let mut listed = windows(("gtk", "4.14.5"));
    listed[0].frame.extents = Some(Extents {
        x: 0,
        y: 0,
        width: 360,
        height: 460,
    });

    place_windows(&mut listed, &ready(vec![shadowed]), None);

    let bounds = listed[0].info.bounds.expect("a position");
    assert_eq!(
        (bounds.x, bounds.y, bounds.width, bounds.height),
        (98.0, 134.0, 420.0, 560.0)
    );
}

#[test]
fn a_window_without_a_shadow_has_the_size_of_its_client_not_the_stale_extents() {
    let mut maximized = client(7, 66, 32);
    maximized.bounds = Some(Extents {
        x: 66,
        y: 32,
        width: 1214,
        height: 768,
    });
    let mut listed = windows(("gtk", "4.14.5"));
    listed[0].frame.extents = Some(Extents {
        x: 0,
        y: 0,
        width: 700,
        height: 520,
    });

    place_windows(&mut listed, &ready(vec![maximized]), None);

    let bounds = listed[0].info.bounds.expect("a position");
    assert_eq!(
        (bounds.x, bounds.y, bounds.width, bounds.height),
        (66.0, 32.0, 1214.0, 768.0)
    );
}

fn gtk3_window_with_shadow(shadow: (i32, i32, i32, i32)) -> (Vec<ListedWindow>, X11State) {
    let mut listed = windows(("gtk", "3.24.41"));
    listed[0].frame.global_position = true;
    listed[0].info.bounds = Some(Rect {
        x: 206.0,
        y: 72.0,
        width: 866.0,
        height: 629.0,
    });
    let mut shadowed = client(7, 206, 72);
    shadowed.shadow = shadow;
    (listed, ready(vec![shadowed]))
}

#[test]
fn a_gtk3_window_with_a_client_side_shadow_is_reported_without_the_shadow() {
    let (mut listed, state) = gtk3_window_with_shadow((26, 23, 26, 29));

    place_windows(&mut listed, &state, None);

    let bounds = listed[0].info.bounds.expect("bounds");
    assert_eq!(
        (bounds.x, bounds.y, bounds.width, bounds.height),
        (232.0, 95.0, 814.0, 577.0)
    );
}

#[test]
fn a_gtk3_window_without_a_shadow_keeps_its_bounds() {
    let (mut listed, state) = gtk3_window_with_shadow((0, 0, 0, 0));

    place_windows(&mut listed, &state, None);

    let bounds = listed[0].info.bounds.expect("bounds");
    assert_eq!(
        (bounds.x, bounds.y, bounds.width, bounds.height),
        (206.0, 72.0, 866.0, 629.0)
    );
}

fn tied_gtk3_windows(first: (i32, i32, i32, i32), second: (i32, i32, i32, i32)) -> Vec<Rect> {
    let (mut listed, _) = gtk3_window_with_shadow(first);
    listed.push(listed[0].clone());
    let twin = |id: u32, shadow| X11Client {
        shadow,
        ..client(id, 206, 72)
    };
    let state = ready(vec![twin(7, first), twin(8, second)]);

    place_windows(&mut listed, &state, None);

    assert_eq!(
        crate::system::window::listed_twins::listed_client(&listed, 0, &state),
        ClientMatch::Several(vec![7, 8])
    );
    listed
        .iter()
        .filter_map(|window| window.info.bounds)
        .collect()
}

#[test]
fn tied_windows_whose_clients_share_a_shadow_lose_it_like_a_single_window() {
    let shadow = (26, 23, 26, 29);
    for bounds in tied_gtk3_windows(shadow, shadow) {
        assert_eq!(
            (bounds.x, bounds.y, bounds.width, bounds.height),
            (232.0, 95.0, 814.0, 577.0)
        );
    }
}

#[test]
fn tied_windows_whose_clients_differ_in_shadow_keep_the_rectangle_they_reported() {
    for bounds in tied_gtk3_windows((26, 23, 26, 29), (0, 0, 0, 0)) {
        assert_eq!(
            (bounds.x, bounds.y, bounds.width, bounds.height),
            (206.0, 72.0, 866.0, 629.0)
        );
    }
}

fn on_desktop(current: u32, window_on: u32) -> Desktops {
    use crate::system::x11::window::desktop_placement::DesktopPlacement;
    Desktops {
        current: Some(current),
        placements: vec![(7, DesktopPlacement::On(window_on))],
    }
}

#[test]
fn a_window_on_another_desktop_is_not_visible() {
    let mut listed = windows(("gtk", "3.24.41"));
    assert_eq!(listed[0].info.state.visible, Some(true));
    place_windows(
        &mut listed,
        &ready(vec![client(7, 0, 0)]),
        Some(&on_desktop(0, 1)),
    );
    assert_eq!(listed[0].info.state.visible, Some(false));
}

#[test]
fn a_window_on_the_current_desktop_or_with_no_desktop_evidence_keeps_what_the_toolkit_said() {
    let mut listed = windows(("gtk", "3.24.41"));
    let state = ready(vec![client(7, 0, 0)]);
    place_windows(&mut listed, &state, Some(&on_desktop(1, 1)));
    assert_eq!(listed[0].info.state.visible, Some(true));
    place_windows(&mut listed, &state, None);
    assert_eq!(listed[0].info.state.visible, Some(true));
}

fn active_client(id: u32) -> X11State {
    X11State::Ready {
        active: Some(id),
        clients: vec![client(7, 460, 165), client(8, 20, 20)],
    }
}

fn origins(listed: &[ListedWindow]) -> Vec<Option<(f64, f64)>> {
    listed
        .iter()
        .map(|window| window.info.bounds.map(|bounds| (bounds.x, bounds.y)))
        .collect()
}

#[test]
fn two_same_titled_windows_are_placed_by_the_active_frame_and_the_active_client() {
    let mut listed = twin_windows(&[false, true]);
    place_windows(&mut listed, &active_client(8), None);
    assert_eq!(
        origins(&listed),
        vec![Some((460.0, 165.0)), Some((20.0, 20.0))]
    );
    let mut swapped = twin_windows(&[true, false]);
    place_windows(&mut swapped, &active_client(8), None);
    assert_eq!(
        origins(&swapped),
        vec![Some((20.0, 20.0)), Some((460.0, 165.0))]
    );
}

#[test]
fn same_titled_windows_nothing_separates_have_no_position() {
    let mut none_active = twin_windows(&[false, false]);
    place_windows(&mut none_active, &active_client(8), None);
    assert_eq!(origins(&none_active), vec![None, None]);
    let mut stranger = twin_windows(&[false, true]);
    place_windows(&mut stranger, &active_client(99), None);
    assert_eq!(origins(&stranger), vec![None, None]);
    let mut three = twin_windows(&[false, false, true]);
    place_windows(&mut three, &active_client(8), None);
    assert_eq!(origins(&three), vec![None, None, None]);
}
