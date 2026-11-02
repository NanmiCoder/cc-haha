use super::{LabelOutcome, from_name, from_text, needs_label};
use crate::tree::Field;
use crate::tree::live::test_support::read_of;
use crate::tree::vocabulary::role_numbers::{PANEL, PUSH_BUTTON};

#[test]
fn a_blank_named_button_needs_its_label_read() {
    assert!(needs_label(&read_of(PUSH_BUTTON, "", &["click"]).node));
}

#[test]
fn a_named_button_does_not() {
    assert!(!needs_label(&read_of(PUSH_BUTTON, "Save", &["click"]).node));
}

#[test]
fn a_blank_container_costs_no_relation_read() {
    assert!(!needs_label(&read_of(PANEL, "", &[]).node));
}

#[test]
fn an_unreadable_name_or_role_is_not_read_blindly() {
    let mut failed_name = read_of(PUSH_BUTTON, "", &["click"]).node;
    failed_name.properties.name = Field::Failed("x".to_owned());
    assert!(!needs_label(&failed_name));
    let mut failed_role = read_of(PUSH_BUTTON, "", &["click"]).node;
    failed_role.traits.role = Field::Failed("x".to_owned());
    assert!(!needs_label(&failed_role));
}

#[test]
fn a_named_label_target_is_settled_by_its_name() {
    assert_eq!(
        from_name(Some(Field::Present("Open".to_owned()))),
        Some(LabelOutcome::Text("Open".to_owned()))
    );
}

#[test]
fn a_blank_label_name_falls_through_to_the_text_of_the_target() {
    assert_eq!(from_name(Some(Field::Present("  ".to_owned()))), None);
    assert_eq!(from_name(Some(Field::Absent)), None);
    assert_eq!(
        from_text(Ok("Open".to_owned())).unwrap(),
        LabelOutcome::Text("Open".to_owned())
    );
}

#[test]
fn a_blank_name_and_no_text_leaves_the_node_unlabelled() {
    assert_eq!(
        from_text(Ok("  ".to_owned())).unwrap(),
        LabelOutcome::Unlabelled
    );
    assert_eq!(
        from_text(Ok(String::new())).unwrap(),
        LabelOutcome::Unlabelled
    );
}

#[test]
fn an_unreadable_label_name_is_a_failure_and_never_reads_the_text() {
    assert_eq!(
        from_name(Some(Field::Failed("gone".to_owned()))),
        Some(LabelOutcome::Failed)
    );
    assert_eq!(from_name(None), Some(LabelOutcome::Failed));
}
