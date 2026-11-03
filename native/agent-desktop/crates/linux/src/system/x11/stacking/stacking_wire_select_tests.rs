use super::{Overlays, RootStackEvidence, select_override_target};
use crate::tree::Extents;

fn rect(x: i32) -> Extents {
    Extents {
        x,
        y: 20,
        width: 24,
        height: 12,
    }
}

#[test]
fn an_override_target_uses_root_siblings_and_keeps_managed_covers_and_input_overlays() {
    let overlay = Overlays {
        bounds: vec![rect(300)],
        receiving: vec![(91, rect(300))],
        names: vec![(91, "input overlay".to_owned())],
    };
    let selected = select_override_target(
        42,
        &[10, 20, 30],
        RootStackEvidence {
            viewable: true,
            override_redirect: true,
            siblings: vec![100, 42, 200, 300],
            managed_frames: vec![(10, 100), (20, 200), (30, 300)],
        },
        overlay.clone(),
    )
    .expect("viewable override target is a unique root sibling");

    assert_eq!(selected.ids, [42, 20, 30]);
    assert_eq!(selected.overlays, overlay);
}

#[test]
fn a_mapped_non_override_target_absent_from_the_managed_list_is_rejected() {
    let selected = select_override_target(
        42,
        &[10, 20],
        RootStackEvidence {
            viewable: true,
            override_redirect: false,
            siblings: vec![100, 42, 200],
            managed_frames: vec![(10, 100), (20, 200)],
        },
        Overlays::default(),
    );

    assert!(selected.is_none());
}

#[test]
fn an_override_target_requires_unique_root_and_client_frame_positions() {
    let ambiguous_target = RootStackEvidence {
        viewable: true,
        override_redirect: true,
        siblings: vec![100, 42, 42, 200],
        managed_frames: vec![(10, 100), (20, 200)],
    };
    assert!(select_override_target(42, &[10, 20], ambiguous_target, Overlays::default()).is_none());

    let missing_frame = RootStackEvidence {
        viewable: true,
        override_redirect: true,
        siblings: vec![100, 42],
        managed_frames: vec![(10, 100), (20, 999)],
    };
    assert!(select_override_target(42, &[10, 20], missing_frame, Overlays::default()).is_none());

    let shared_frame = RootStackEvidence {
        viewable: true,
        override_redirect: true,
        siblings: vec![100, 42],
        managed_frames: vec![(10, 100), (20, 100)],
    };
    assert!(select_override_target(42, &[10, 20], shared_frame, Overlays::default()).is_none());
}
