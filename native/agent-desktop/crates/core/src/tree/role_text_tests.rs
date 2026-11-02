use super::value_is_the_readable_text;

/// The roles whose value is the content, and the ones whose name is.
#[test]
fn a_text_bearing_control_reads_from_its_value() {
    for role in ["textfield", "combobox", "listbox", "datefield", "timefield"] {
        assert!(
            value_is_the_readable_text(role),
            "{role} carries its content in its value"
        );
    }
}

/// The counterexamples that disqualified reusing `is_mutable_value_role`: its
/// true-branch holds all four of these, so borrowing it would have made a
/// checkbox answer its state token and a slider answer its number.
#[test]
fn a_state_or_position_bearing_control_reads_from_its_name() {
    for role in ["checkbox", "radiobutton", "switch", "slider", "incrementor"] {
        assert!(
            !value_is_the_readable_text(role),
            "{role} carries a state or a position in its value, not text a person reads"
        );
        assert!(
            crate::tree::roles::is_mutable_value_role(role),
            "{role} is in the other predicate's true-branch, which is why the two must not \
             be confused"
        );
    }
}

#[test]
fn a_labelled_control_with_no_content_reads_from_its_name() {
    for role in [
        "button",
        "menuitem",
        "link",
        "tab",
        "statictext",
        "cell",
        "treeitem",
    ] {
        assert!(!value_is_the_readable_text(role));
    }
}

/// An unrecognised token resolves to `Role::Unknown`, which reads from the name
/// like every other unclassified role rather than falling into a catch-all.
#[test]
fn an_unrecognised_role_reads_from_its_name() {
    assert!(!value_is_the_readable_text("no-such-role"));
}
