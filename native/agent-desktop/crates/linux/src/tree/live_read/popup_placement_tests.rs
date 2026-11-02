use super::*;
use crate::tree::Field;
use crate::tree::live::test_support::{read_of, words};
use crate::tree::live_read::live_project::live_state;
use crate::tree::observe::node_evidence::evidence_for;
use crate::tree::vocabulary::role_numbers::PUSH_BUTTON;

fn rect(x: i32, y: i32, width: i32, height: i32) -> Extents {
    Extents {
        x,
        y,
        width,
        height,
    }
}

#[test]
fn menu_regression_gtk3_popup_visibility_uses_the_native_popup() {
    use crate::system::x11::PopupWindow;
    let mut read = read_of(PUSH_BUTTON, "About", &["click"]);
    read.node.traits.states = Field::Present(words(&[8, 25, 30]));
    read.node.extents = Field::Present(rect(479, 212, 118, 27));
    let mut placement = Placement {
        node: Some(rect(0, 27, 118, 27)),
        frame: Some(rect(251, 51, 45, 27)),
        toolkit: crate::system::process::toolkit_id::ToolkitId {
            name: Some("GTK".to_owned()),
            version: Some("3.24.41".to_owned()),
        },
        ..Placement::default()
    };
    apply_popup(
        &mut placement,
        Some(PopupWindow {
            id: 7,
            bounds: rect(479, 185, 118, 54),
        }),
    );
    let evidence = evidence_for(&read, &read.node.element);
    assert_eq!(
        live_state(&read, &evidence, &placement)
            .expect("state")
            .offscreen,
        Some(false)
    );
    apply_popup(&mut placement, None);
    assert_eq!(
        live_state(&read, &evidence, &placement)
            .expect("state")
            .offscreen,
        None
    );
}
