use super::*;
use crate::tree::resolve::resolve_fake::{FRAME_PATH, Fake, node};
use crate::tree::vocabulary::role_numbers::{CHECK_BOX, PUSH_BUTTON};

#[test]
fn only_nodes_whose_role_can_be_the_stored_role_are_read_in_full() {
    let mut fake = Fake::new();
    fake.add(FRAME_PATH, "/one", node(PUSH_BUTTON, "7", 10, 10));
    fake.add(FRAME_PATH, "/two", node(CHECK_BOX, "7", 10, 10));
    fake.add(FRAME_PATH, "/three", node(PUSH_BUTTON, "8", 10, 10));
    let entry = fake.entry_of("/one", false);
    let walk = fake.walk();
    let mut found = Vec::new();
    targets(&walk.root, &entry, &mut found);
    let paths: Vec<&str> = found.iter().map(AtspiElement::path).collect();
    assert_eq!(paths, ["/one", "/three"]);
}

#[test]
fn full_reads_replace_only_the_nodes_that_were_targeted_in_walk_order() {
    let mut fake = Fake::new();
    fake.add(FRAME_PATH, "/one", node(PUSH_BUTTON, "7", 10, 10));
    fake.add(FRAME_PATH, "/two", node(CHECK_BOX, "7", 10, 10));
    fake.add(FRAME_PATH, "/three", node(PUSH_BUTTON, "8", 10, 10));
    let entry = fake.entry_of("/one", false);
    let mut walk = fake.walk();
    let fresh = |name: &str, path: &str| {
        let mut read = node(PUSH_BUTTON, name, 1, 1);
        read.node.element = AtspiElement::new(":1.2", path, 40);
        read
    };
    let mut reads = vec![fresh("a", "/one"), fresh("b", "/three")].into_iter();
    fill(&mut walk.root, &entry, &mut reads);
    let names: Vec<_> = walk
        .root
        .children
        .iter()
        .map(|child| child.payload.node.properties.name.present().cloned())
        .collect();
    assert_eq!(
        names,
        [
            Some("a".to_owned()),
            Some("7".to_owned()),
            Some("b".to_owned())
        ]
    );
}

#[test]
fn twin_buttons_both_stay_candidates_and_the_search_stays_ambiguous() {
    use crate::tree::resolve::resolve_search::evaluate;
    let mut fake = Fake::new();
    fake.add(FRAME_PATH, "/one", node(PUSH_BUTTON, "7", 10, 10));
    fake.add(FRAME_PATH, "/twin", node(PUSH_BUTTON, "7", 10, 10));
    let mut entry = fake.entry_of("/one", false);
    entry.geometry.bounds = None;
    let walk = fake.walk();
    let mut found = Vec::new();
    targets(&walk.root, &entry, &mut found);
    assert_eq!(found.len(), 2);
    assert_eq!(evaluate(&walk, &entry, false).candidates.len(), 2);
}
