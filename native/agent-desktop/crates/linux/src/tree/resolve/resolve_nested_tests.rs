use super::*;
use crate::tree::resolve::resolve_fake::{FRAME_PATH, Fake, deadline, node};
use crate::tree::vocabulary::role_numbers::{PANEL, PUSH_BUTTON};

fn row_with_label() -> Fake {
    let mut fake = Fake::new();
    fake.add(FRAME_PATH, "/row", node(PUSH_BUTTON, "alpha", 300, 30));
    fake.add("/row", "/label", node(PUSH_BUTTON, "alpha", 200, 20));
    fake
}

fn resolved_path(fake: &mut Fake, of: &str) -> String {
    let mut entry = fake.entry_of(of, false);
    entry.geometry.bounds = None;
    resolve(fake, &entry, deadline())
        .expect("the ref resolves")
        .path()
        .to_owned()
}

#[test]
fn a_row_and_the_label_inside_it_are_not_twins() {
    let mut fake = row_with_label();
    assert_eq!(resolved_path(&mut fake, "/row"), "/row");
    assert_eq!(resolved_path(&mut fake, "/label"), "/label");
}

#[test]
fn separate_rows_with_the_same_name_stay_ambiguous_even_when_nested_relatives_exist() {
    let mut fake = row_with_label();
    fake.add(FRAME_PATH, "/other", node(PANEL, "list", 300, 30));
    fake.add("/other", "/twin", node(PUSH_BUTTON, "alpha", 200, 20));
    let mut entry = fake.entry_of("/label", false);
    entry.geometry.bounds = None;
    let error = resolve(&mut fake, &entry, deadline()).expect_err("twins are refused");
    assert_eq!(error.code, ErrorCode::AmbiguousTarget);
}
