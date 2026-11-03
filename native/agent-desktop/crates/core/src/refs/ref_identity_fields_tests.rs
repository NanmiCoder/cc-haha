use super::super::identity_fields_are_meaningful;

#[test]
fn identity_fields_report_own_evidence_and_ignore_a_retained_object() {
    assert!(!identity_fields_are_meaningful(
        "button", None, None, None, None
    ));
    assert!(!identity_fields_are_meaningful(
        "button",
        Some(""),
        None,
        Some(""),
        Some("")
    ));
    assert!(identity_fields_are_meaningful(
        "button",
        Some("Save"),
        None,
        None,
        None
    ));
    assert!(identity_fields_are_meaningful(
        "button",
        None,
        None,
        None,
        Some("save")
    ));
    assert!(identity_fields_are_meaningful(
        "textfield",
        Some("Search"),
        None,
        None,
        None
    ));
}
