use super::*;
use crate::tree::live::test_support::words;

#[test]
fn frames_without_a_component_are_not_top_levels() {
    use crate::tree::surfaces::top_level::is_top_level;
    assert!(!is_top_level(&Field::Present(vec![])));
    assert!(!is_top_level(&Field::Failed("x".into())));
}

#[test]
fn state_bits_become_visible_minimized_and_active() {
    let shown = frame_state(&Field::Present(words(&[25, 1])));
    assert_eq!(
        shown,
        FrameState {
            visible: Some(true),
            minimized: Some(false),
            active: Some(true),
            modal: Some(false)
        }
    );
    let hidden = frame_state(&Field::Present(words(&[15])));
    assert_eq!(hidden.visible, Some(false));
    assert_eq!(hidden.minimized, Some(true));
}

#[test]
fn native_window_types_require_complete_uniform_process_or_geometry_groups() {
    use crate::system::x11::{FrameFacts, X11Client};
    use crate::tree::Extents;
    let bounds = Extents {
        x: 31,
        y: 47,
        width: 300,
        height: 200,
    };
    let frame = FrameFacts {
        pid: 7,
        title: "arbitrary title".into(),
        extents: Some(bounds),
        global_position: true,
        size_identity: false,
    };
    let client = X11Client {
        id: 20,
        pid: Some(7),
        title: "unrelated title".into(),
        bounds: Some(bounds),
        extents: None,
        hidden: false,
        shadow: (0, 0, 0, 0),
    };
    let users = std::collections::HashSet::from([20, 21]);
    let helpers = std::collections::HashSet::new();
    let classify = |frames: &[FrameFacts], clients: &[X11Client]| {
        classify_frames(&frame, frames, clients, &users, &helpers, true)
    };
    let one = std::slice::from_ref(&frame);
    assert!(classify(one, std::slice::from_ref(&client)).unwrap());
    assert!(classify(one, &[]).is_err());
    let wrong = X11Client {
        bounds: Some(Extents { x: 99, ..bounds }),
        ..client.clone()
    };
    assert!(classify(one, std::slice::from_ref(&wrong)).unwrap());
    assert!(
        classify_frames(
            &frame,
            one,
            std::slice::from_ref(&wrong),
            &users,
            &helpers,
            false
        )
        .is_err()
    );
    assert!(
        classify(
            one,
            &[X11Client {
                pid: Some(8),
                ..wrong
            }]
        )
        .is_err()
    );
    let twins = [frame.clone(), frame.clone()];
    let natives = [client.clone(), X11Client { id: 21, ..client }];
    assert!(classify(&twins, &natives).unwrap());
    assert!(classify_frames(&frame, &twins, &natives, &users, &helpers, false).is_err());
    assert!(classify(one, &natives).is_err());
    assert!(classify(&twins, &natives[..1]).is_err());
    assert!(
        classify_frames(
            &frame,
            &twins,
            &natives,
            &std::collections::HashSet::from([20]),
            &std::collections::HashSet::from([21]),
            true,
        )
        .is_err()
    );
    assert!(!classify_frames(&frame, &twins, &natives, &helpers, &users, true).unwrap());
}

#[test]
fn a_proven_native_menu_does_not_hide_a_managed_window() {
    use crate::system::x11::{FrameFacts, X11Client};
    use crate::tree::Extents;
    let bounds = Extents {
        x: 100,
        y: 100,
        width: 400,
        height: 500,
    };
    let frame = FrameFacts {
        pid: 7,
        title: "document".into(),
        extents: Some(bounds),
        global_position: true,
        size_identity: false,
    };
    let managed = X11Client {
        id: 20,
        pid: Some(7),
        title: "document".into(),
        bounds: Some(bounds),
        extents: None,
        hidden: false,
        shadow: (0, 0, 0, 0),
    };
    let menu = X11Client {
        id: 21,
        title: String::new(),
        bounds: Some(Extents {
            width: 200,
            height: 300,
            ..bounds
        }),
        ..managed.clone()
    };
    let users = std::collections::HashSet::from([20]);
    let helpers = std::collections::HashSet::from([21]);
    let frames = std::slice::from_ref(&frame);
    assert!(
        classify_frames(
            &frame,
            frames,
            std::slice::from_ref(&menu),
            &users,
            &helpers,
            true
        )
        .is_err(),
        "a menu at other bounds cannot account for an accessibility frame"
    );
    assert!(
        classify_frames(
            &frame,
            frames,
            &[managed.clone(), menu.clone()],
            &users,
            &helpers,
            true
        )
        .unwrap()
    );
    assert!(
        classify_frames(
            &frame,
            frames,
            &[managed.clone(), menu.clone()],
            &users,
            &helpers,
            false
        )
        .is_err()
    );
    let twin = X11Client {
        bounds: Some(bounds),
        ..menu
    };
    assert!(classify_frames(&frame, frames, &[managed, twin], &users, &helpers, true).is_err());
}

fn listed(
    frame: &crate::system::x11::FrameFacts,
) -> crate::system::registry::listed_window::ListedWindow {
    use agent_desktop_core::{WindowInfo, WindowState};
    crate::system::registry::listed_window::ListedWindow {
        app: 0,
        info: WindowInfo {
            id: format!("{:?}", frame.extents),
            title: frame.title.clone(),
            app: "app".into(),
            pid: frame.pid.into(),
            process_instance: Some("boot:1".into()),
            bounds: None,
            state: WindowState {
                visible: Some(true),
                minimized: Some(false),
                ..WindowState::default()
            },
        },
        active: false,
        modal: false,
        dialog: false,
        frame: frame.clone(),
        sheet: false,
        unshown: false,
    }
}

fn classify_frames(
    frame: &crate::system::x11::FrameFacts,
    frames: &[crate::system::x11::FrameFacts],
    clients: &[crate::system::x11::X11Client],
    users: &std::collections::HashSet<u32>,
    helpers: &std::collections::HashSet<u32>,
    complete: bool,
) -> Result<bool, agent_desktop_core::AdapterError> {
    native_group::classify(
        &listed(frame),
        &frames.iter().map(listed).collect::<Vec<_>>(),
        clients,
        users,
        helpers,
        complete,
    )
}

#[test]
fn embedded_accessibility_frames_preserve_the_unique_native_window_and_refuse_unknowns() {
    use crate::system::x11::{FrameFacts, X11Client};
    use crate::tree::Extents;
    use std::collections::HashSet;
    let bounds = Extents {
        x: 10,
        y: 10,
        width: 1050,
        height: 780,
    };
    let main = FrameFacts {
        pid: 7,
        title: "arbitrary".into(),
        extents: Some(bounds),
        global_position: true,
        size_identity: false,
    };
    let embedded = FrameFacts {
        title: String::new(),
        extents: Some(Extents {
            x: 114,
            y: 40,
            width: 757,
            height: 88,
        }),
        ..main.clone()
    };
    let frames = vec![listed(&main), listed(&embedded)];
    let client = X11Client {
        id: 20,
        pid: Some(7),
        title: main.title.clone(),
        bounds: Some(bounds),
        extents: None,
        hidden: false,
        shadow: (0, 0, 0, 0),
    };
    let users = HashSet::from([20]);
    let helpers = HashSet::new();
    let clients = std::slice::from_ref(&client);
    assert!(native_group::classify(&frames[0], &frames, clients, &users, &helpers, true).unwrap());
    assert!(!native_group::classify(&frames[1], &frames, clients, &users, &helpers, true).unwrap());
    for variant in 0..9 {
        let mut unsafe_frames = frames.clone();
        let mut unsafe_users = users.clone();
        match variant {
            0 => unsafe_frames[1].modal = true,
            1 => unsafe_frames[1].dialog = true,
            2 => unsafe_frames[1].frame.global_position = false,
            3 => unsafe_frames[1].frame.extents = None,
            4 => unsafe_frames[1].frame.extents.as_mut().unwrap().x = -100,
            5 => {
                unsafe_users.insert(21);
            }
            6 => unsafe_frames.push(frames[0].clone()),
            7 => unsafe_frames[1].info.state.visible = None,
            _ => unsafe_frames[1].info.state.minimized = None,
        }
        assert!(
            native_group::classify(
                &unsafe_frames[0],
                &unsafe_frames,
                clients,
                &unsafe_users,
                &helpers,
                true
            )
            .is_err(),
            "unsafe variant {variant}"
        );
    }
    assert!(native_group::classify(&frames[0], &frames, clients, &users, &helpers, false).is_err());
    let menu_bounds = Extents {
        x: 300,
        y: 300,
        width: 200,
        height: 200,
    };
    let menu = FrameFacts {
        extents: Some(menu_bounds),
        ..embedded.clone()
    };
    let mixed_frames = [frames[0].clone(), frames[1].clone(), listed(&menu)];
    let mixed_clients = [
        client.clone(),
        X11Client {
            id: 21,
            bounds: Some(menu_bounds),
            ..client
        },
    ];
    let helpers = HashSet::from([21]);
    for (index, expected) in [true, false, false].into_iter().enumerate() {
        assert_eq!(
            native_group::classify(
                &mixed_frames[index],
                &mixed_frames,
                &mixed_clients,
                &users,
                &helpers,
                true
            )
            .unwrap(),
            expected
        );
    }
}
