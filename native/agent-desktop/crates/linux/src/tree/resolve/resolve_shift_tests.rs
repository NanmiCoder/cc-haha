use agent_desktop_core::ErrorCode;

use super::resolve;
use crate::tree::resolve::resolve_fake::{FRAME_PATH, Fake, deadline, node};
use crate::tree::vocabulary::role_numbers::PUSH_BUTTON;

fn buttons() -> Fake {
    let mut fake = Fake::new();
    fake.add(FRAME_PATH, "/other", node(PUSH_BUTTON, "Other", 30, 20));
    fake.add(FRAME_PATH, "/save-a", node(PUSH_BUTTON, "Save", 80, 20));
    fake.add(FRAME_PATH, "/save-b", node(PUSH_BUTTON, "Save", 140, 20));
    fake
}

fn remove_other(fake: &mut Fake) {
    fake.nodes
        .get_mut(FRAME_PATH)
        .expect("frame")
        .children
        .retain(|path| path != "/other");
}

#[test]
fn shifted_same_named_sibling_without_bounds_is_ambiguous() {
    let mut fake = buttons();
    let entry = fake.entry_of("/save-a", false);
    assert_eq!(entry.scope.path.as_slice(), [1]);
    assert!(entry.geometry.bounds.is_none());
    assert!(entry.identity.native_id.is_none());
    assert!(entry.identity.retained_object.is_none());
    remove_other(&mut fake);
    let error =
        resolve(&mut fake, &entry, deadline()).expect_err("Save B must not receive the ref");
    assert_eq!(error.code, ErrorCode::AmbiguousTarget);
    assert_eq!(error.details.expect("details")["candidate_count"], 2);
}

#[test]
fn shifted_same_named_sibling_with_distinguishing_size_resolves_original() {
    let mut fake = buttons();
    let entry = fake.entry_of("/save-a", true);
    remove_other(&mut fake);
    let element = resolve(&mut fake, &entry, deadline()).expect("size distinguishes Save A");
    assert_eq!(element.path(), "/save-a");
}

#[test]
fn shifted_unique_name_without_bounds_resolves_original() {
    let mut fake = buttons();
    fake.nodes
        .get_mut("/save-b")
        .expect("Save B")
        .read
        .node
        .properties
        .name = crate::tree::Field::Present("Cancel".to_owned());
    let entry = fake.entry_of("/save-a", false);
    remove_other(&mut fake);
    let element = resolve(&mut fake, &entry, deadline()).expect("the only Save still resolves");
    assert_eq!(element.path(), "/save-a");
}

#[test]
fn shifted_anonymous_siblings_need_unchanged_distinguishing_geometry() {
    for shrink in [0, 1] {
        let mut fake = Fake::new();
        fake.add(FRAME_PATH, "/other", node(PUSH_BUTTON, "Other", 30, 20));
        fake.add(FRAME_PATH, "/first", node(PUSH_BUTTON, "", 80, 20));
        fake.add(FRAME_PATH, "/second", node(PUSH_BUTTON, "", 80, 20));
        let entry = fake.entry_of("/first", true);
        assert_eq!(entry.scope.path.as_slice(), [1]);
        assert!(!agent_desktop_core::refs::ref_identity::has_meaningful_identity(&entry));
        assert_ne!(
            entry.geometry.bounds_space,
            Some(agent_desktop_core::BoundsSpace::Window)
        );
        remove_other(&mut fake);
        for path in ["/first", "/second"] {
            fake.nodes.get_mut(path).expect("sibling").read.node.extents =
                crate::tree::Field::Present(crate::tree::Extents {
                    x: 0,
                    y: 0,
                    width: 80,
                    height: 20 - shrink,
                });
        }
        let error = resolve(&mut fake, &entry, deadline())
            .expect_err("the shifted path cannot identify an anonymous sibling");
        if shrink == 0 {
            assert_eq!(error.code, ErrorCode::AmbiguousTarget);
            assert_eq!(error.details.expect("details")["candidate_count"], 2);
        } else {
            assert_eq!(error.code, ErrorCode::StaleRef);
        }
    }
}
