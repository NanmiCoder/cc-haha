use agent_desktop_core::{AdapterError, Deadline};

use super::{PopupPosition, popup_position_via};
use crate::system::process::toolkit_id::ToolkitId;
use crate::tree::live::test_support::read_of;
use crate::tree::live_read::NodeReader;
use crate::tree::observe::node_evidence::{NodeEvidence, evidence_for};
use crate::tree::placement::Placement;
use crate::tree::vocabulary::role_numbers::PUSH_BUTTON;
use crate::tree::{
    AtspiElement, Extents, Field, element::ancestry, properties::liveness::Liveness,
};

struct Reader {
    global: bool,
    placement: Placement,
    extents: Field<Extents>,
}

impl NodeReader for Reader {
    fn read(&mut self, element: &AtspiElement) -> Result<NodeEvidence, AdapterError> {
        let mut read = read_of(PUSH_BUTTON, "Wrap", &["click"]);
        read.node.extents = self.extents.clone();
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
        self.placement.clone()
    }

    fn global_position(&mut self, _element: &AtspiElement, _deadline: Deadline) -> bool {
        self.global
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

fn gtk4() -> ToolkitId {
    ToolkitId {
        name: Some("GTK".to_owned()),
        version: Some("4.14.5".to_owned()),
    }
}

fn popup_placement() -> Placement {
    Placement {
        node: Some(rect(110, 220, 30, 20)),
        frame: Some(rect(100, 200, 400, 300)),
        toolkit: gtk4(),
        ..Placement::default()
    }
}

fn gtk4_reader(placement: Placement) -> Reader {
    Reader {
        global: false,
        placement,
        extents: Field::Present(rect(0, 0, 30, 20)),
    }
}

fn menu_handle() -> agent_desktop_core::NativeHandle {
    let mut element = AtspiElement::new(":1.1", "/menu/wrap", 40);
    element.set_ancestry(ancestry::of_root(&AtspiElement::new(":1.1", "/menu", 40)));
    element.set_menu_owner(&AtspiElement::new(":1.1", "/window", 40));
    element.into_native_handle()
}

fn position(reader: &mut Reader) -> PopupPosition {
    let deadline = Deadline::after(5_000).expect("deadline builds");
    popup_position_via(reader, &menu_handle(), deadline).expect("a position")
}

#[test]
fn an_item_of_a_popup_with_a_viewable_window_is_placed() {
    let mut placement = popup_placement();
    placement.popup_origin = Some((400, 400));
    assert_eq!(position(&mut gtk4_reader(placement)), PopupPosition::Placed);
}

#[test]
fn an_item_of_a_popup_that_no_viewable_window_answers_for_is_unmapped() {
    assert_eq!(
        position(&mut gtk4_reader(popup_placement())),
        PopupPosition::Unmapped
    );
}

#[test]
fn a_popup_whose_place_was_not_read_is_not_called_closed() {
    for placement in [
        Placement {
            frame: None,
            ..popup_placement()
        },
        Placement {
            node: None,
            ..popup_placement()
        },
    ] {
        assert_eq!(
            position(&mut gtk4_reader(placement)),
            PopupPosition::Unplaceable
        );
    }
}

#[test]
fn a_session_that_cannot_place_popups_does_not_call_an_open_one_closed() {
    let placement = Placement {
        wayland_unplaced: true,
        ..popup_placement()
    };
    assert_eq!(
        position(&mut gtk4_reader(placement)),
        PopupPosition::Unplaceable
    );
}

#[test]
fn a_toolkit_with_global_positions_is_placed_by_its_own_extents() {
    let mut placed = Reader {
        global: true,
        placement: Placement::default(),
        extents: Field::Present(rect(641, 401, 30, 20)),
    };
    assert_eq!(position(&mut placed), PopupPosition::Placed);
    let mut off_screen = Reader {
        global: true,
        placement: Placement::default(),
        extents: Field::Present(rect(i32::MIN, i32::MIN, 30, 20)),
    };
    assert_eq!(position(&mut off_screen), PopupPosition::Unplaceable);
}
