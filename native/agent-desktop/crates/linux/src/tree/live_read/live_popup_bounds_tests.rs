use agent_desktop_core::{AdapterError, Deadline, NativeHandle, Rect};

use super::*;
use crate::system::x11::window::window_x11_state::WindowX11State;
use crate::tree::element::ancestry;
use crate::tree::live::test_support::{read_of, words};
use crate::tree::observe::node_evidence::evidence_for;
use crate::tree::vocabulary::role_numbers::PUSH_BUTTON;
use crate::tree::{AtspiElement, Extents, Field, live_read::live_offscreen::select_frame_origin};

struct PopupPlacementReader {
    popup_candidates: Vec<(i32, i32)>,
    managed: Option<WindowX11State>,
    managed_reads: usize,
}

impl NodeReader for PopupPlacementReader {
    fn read(&mut self, element: &AtspiElement) -> Result<NodeEvidence, AdapterError> {
        let mut read = read_of(PUSH_BUTTON, "Open", &["click"]);
        read.node.extents = Field::Present(rect(0, 0, 30, 20));
        Ok(NodeEvidence {
            evidence: evidence_for(&read, element),
            read,
            liveness: Liveness::Alive,
        })
    }

    fn stopped_app(&mut self, _pid: u32) -> Option<String> {
        None
    }

    fn placement(&mut self, _element: &AtspiElement, _deadline: Deadline) -> Placement {
        let frame = rect(100, 200, 400, 300);
        let (popup_origin, x11) = select_frame_origin(
            true,
            Some(frame),
            |_| (self.popup_candidates.len() == 1).then(|| self.popup_candidates[0]),
            || {
                self.managed_reads += 1;
                self.managed
            },
        );
        Placement {
            node: Some(rect(110, 220, 30, 20)),
            frame: Some(frame),
            toolkit: gtk4(),
            popup_origin,
            x11,
            ..Placement::default()
        }
    }

    fn global_position(&mut self, _element: &AtspiElement, _deadline: Deadline) -> bool {
        false
    }
}

fn rect(x: i32, y: i32, width: i32, height: i32) -> Extents {
    Extents {
        x,
        y,
        width,
        height,
    }
}

fn gtk4() -> crate::system::process::toolkit_id::ToolkitId {
    crate::system::process::toolkit_id::ToolkitId {
        name: Some("GTK".to_owned()),
        version: Some("4.14.5".to_owned()),
    }
}

fn deadline() -> Deadline {
    Deadline::after(5_000).expect("deadline builds")
}

fn menu_element() -> AtspiElement {
    let mut element = AtspiElement::new(":1.1", "/menu/open", 40);
    element.set_ancestry(ancestry::of_root(&AtspiElement::new(":1.1", "/menu", 40)));
    element.set_menu_owner(&AtspiElement::new(":1.1", "/window", 40));
    element
}

fn menu_handle() -> NativeHandle {
    menu_element().into_native_handle()
}

fn managed_decoy() -> WindowX11State {
    WindowX11State {
        client_id: 99,
        hidden: false,
        client_origin: (5, 7),
        shadow: (0, 0, 0, 0),
    }
}

#[test]
fn bounds_via_uses_the_unique_popup_origin_and_never_the_managed_decoy() {
    let mut reader = PopupPlacementReader {
        popup_candidates: vec![(500, 600)],
        managed: Some(managed_decoy()),
        managed_reads: 0,
    };

    let bounds = bounds_via(&mut reader, &menu_handle(), deadline())
        .expect("bounds read")
        .expect("matched popup has bounds");

    assert_eq!(
        bounds,
        Rect {
            x: 510.0,
            y: 620.0,
            width: 30.0,
            height: 20.0
        }
    );
    assert_eq!(reader.managed_reads, 0);
}

#[test]
fn an_absent_or_ambiguous_popup_origin_produces_no_bounds_without_fallback() {
    for popup_candidates in [vec![], vec![(500, 600), (700, 800)]] {
        let mut reader = PopupPlacementReader {
            popup_candidates,
            managed: Some(managed_decoy()),
            managed_reads: 0,
        };
        assert!(
            bounds_via(&mut reader, &menu_handle(), deadline())
                .expect("bounds read")
                .is_none()
        );
        assert_eq!(reader.managed_reads, 0);
    }
}

#[test]
fn ordinary_frames_keep_the_managed_window_origin() {
    let managed = managed_decoy();
    let mut popup_asked = false;
    let (popup, x11) = select_frame_origin(
        false,
        Some(rect(100, 200, 400, 300)),
        |_| {
            popup_asked = true;
            Some((500, 600))
        },
        || Some(managed),
    );
    assert_eq!(popup, None);
    assert_eq!(x11, Some(managed));
    assert!(!popup_asked);
}

#[test]
fn a_viewable_popup_is_known_not_minimized() {
    let mut read = read_of(PUSH_BUTTON, "Open", &["click"]);
    read.node.traits.states = Field::Present(words(&[8, 25]));
    let mut reader = PopupPlacementReader {
        popup_candidates: vec![(500, 600)],
        managed: None,
        managed_reads: 0,
    };
    let mut placement = reader.placement(&menu_element(), deadline());
    placement.node = Some(rect(110, 220, 30, 20));
    assert_eq!(
        live_state(
            &read,
            &evidence_for(&read, &AtspiElement::new(":1.1", "/menu/open", 40)),
            &placement
        )
        .expect("state")
        .offscreen,
        Some(false)
    );
}
