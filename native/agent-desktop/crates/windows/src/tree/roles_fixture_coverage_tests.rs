use super::super::{FIXTURE_COVERED_ROLES, FIXTURE_UNCOVERED_ROLES};
use super::{ControlType, PropertyOutcome, TreeProperty, flag, role_of};

/// One `role_of` input: a `ControlType` and the refinement-gate flags to
/// drive through it. Declared as data rather than inlined into
/// [`all_producible_roles`] directly, so [`producible_set_gate_flag_count`]
/// can count the flags this table actually threads through
/// [`super::super::imp::control_type_role`]'s refinement helpers without
/// duplicating the list.
fn producible_cases() -> Vec<(ControlType, Vec<(TreeProperty, PropertyOutcome)>)> {
    vec![
        (ControlType::Button, Vec::new()),
        (
            ControlType::Button,
            vec![flag(TreeProperty::ToggleAvailable, true)],
        ),
        (
            ControlType::Button,
            vec![flag(TreeProperty::ExpandCollapseAvailable, true)],
        ),
        (ControlType::Calendar, Vec::new()),
        (ControlType::CheckBox, Vec::new()),
        (ControlType::ComboBox, Vec::new()),
        (ControlType::Edit, Vec::new()),
        (ControlType::Hyperlink, Vec::new()),
        (ControlType::Image, Vec::new()),
        (ControlType::ListItem, Vec::new()),
        (ControlType::List, Vec::new()),
        (
            ControlType::List,
            vec![flag(TreeProperty::SelectionAvailable, true)],
        ),
        (ControlType::Menu, Vec::new()),
        (ControlType::MenuBar, Vec::new()),
        (ControlType::MenuItem, Vec::new()),
        (ControlType::ProgressBar, Vec::new()),
        (ControlType::RadioButton, Vec::new()),
        (ControlType::ScrollBar, Vec::new()),
        (ControlType::Slider, Vec::new()),
        (ControlType::Spinner, Vec::new()),
        (ControlType::StatusBar, Vec::new()),
        (ControlType::Tab, Vec::new()),
        (ControlType::TabItem, Vec::new()),
        (ControlType::Text, Vec::new()),
        (ControlType::ToolBar, Vec::new()),
        (ControlType::ToolTip, Vec::new()),
        (ControlType::Tree, Vec::new()),
        (ControlType::TreeItem, Vec::new()),
        (ControlType::Custom, Vec::new()),
        (
            ControlType::Custom,
            vec![flag(TreeProperty::GridItemAvailable, true)],
        ),
        (
            ControlType::Custom,
            vec![flag(TreeProperty::TableItemAvailable, true)],
        ),
        (ControlType::Group, Vec::new()),
        (ControlType::Thumb, Vec::new()),
        (ControlType::DataGrid, Vec::new()),
        (ControlType::DataItem, Vec::new()),
        (
            ControlType::DataItem,
            vec![flag(TreeProperty::GridItemAvailable, true)],
        ),
        (
            ControlType::DataItem,
            vec![flag(TreeProperty::TableItemAvailable, true)],
        ),
        (ControlType::Document, Vec::new()),
        (
            ControlType::Document,
            vec![
                flag(TreeProperty::ValueAvailable, true),
                flag(TreeProperty::ValueIsReadOnly, false),
            ],
        ),
        (ControlType::SplitButton, Vec::new()),
        (ControlType::Window, Vec::new()),
        (ControlType::Pane, Vec::new()),
        (
            ControlType::Pane,
            vec![flag(TreeProperty::WindowAvailable, true)],
        ),
        (ControlType::Pane, vec![flag(TreeProperty::IsDialog, true)]),
        (ControlType::Header, Vec::new()),
        (ControlType::HeaderItem, Vec::new()),
        (ControlType::Table, Vec::new()),
        (ControlType::TitleBar, Vec::new()),
        (ControlType::Separator, Vec::new()),
        (ControlType::SemanticZoom, Vec::new()),
        (ControlType::AppBar, Vec::new()),
    ]
}

/// Every role [`super::super::control_type_role`] can produce, computed by
/// driving each `ControlType` arm through the same [`role_of`] helper the
/// vocabulary tests use, for every refinement-gate flag combination that
/// changes the answer. This is the map's actual producible set as of the
/// case table above, so
/// [`fixture_covered_and_uncovered_roles_union_to_the_map_producible_set`]
/// below checks the pin against that set.
///
/// That table is still hand-written, so it can drift the same way the
/// pin it feeds is meant to guard against: a refinement branch added inside
/// `roles.rs` that this table's cases never drive would silently keep the
/// union test green. [`refinement_gate_flags_in_the_producible_set_match_the_gate_calls_roles_rs_makes`]
/// closes that gap by pinning the case table's flag count against the
/// number of gate calls `roles.rs`'s source actually makes, so a case
/// missing from the table cannot pass unnoticed - see that test's doc
/// comment for why a textual source count, rather than a second hand list,
/// is the honest fallback here.
fn all_producible_roles() -> Vec<String> {
    producible_cases()
        .into_iter()
        .map(|(control_type, extra)| role_of(control_type, extra))
        .collect()
}

/// The total number of refinement-gate flags [`producible_cases`] threads
/// through [`role_of`] - one per `is_true`/`gated_flag` call the case is
/// meant to exercise inside `roles.rs`.
fn producible_set_gate_flag_count() -> usize {
    producible_cases()
        .iter()
        .map(|(_, extra)| extra.len())
        .sum()
}

/// The fixture-coverage decision: every role the map can produce must be
/// classified as either required-of-the-fixture or explicitly out of scope,
/// with nothing left uncategorized. A `ControlType` arm added later that
/// yields a role in neither set fails this test rather than silently
/// escaping both the fixture's assertions and this pin - provided
/// [`producible_cases`] was updated to drive the new arm; see
/// [`refinement_gate_flags_in_the_producible_set_match_the_gate_calls_roles_rs_makes`]
/// for what forces that update.
#[test]
fn fixture_covered_and_uncovered_roles_union_to_the_map_producible_set() {
    let mut produced = all_producible_roles();
    produced.sort();
    produced.dedup();

    let mut declared: Vec<String> = FIXTURE_COVERED_ROLES
        .iter()
        .chain(FIXTURE_UNCOVERED_ROLES.iter())
        .map(|role| role.to_string())
        .collect();
    declared.sort();
    declared.dedup();

    assert_eq!(
        declared, produced,
        "FIXTURE_COVERED_ROLES union FIXTURE_UNCOVERED_ROLES must equal exactly the roles control_type_role can produce"
    );
}

/// [`producible_cases`] cannot be derived mechanically from `roles.rs`
/// without parsing Rust source, so this is the honest fallback the fixture
/// instead: a textual count of every
/// `properties.is_true(TreeProperty::` and `properties.gated_flag(TreeProperty::`
/// call in `roles.rs`'s own source, pinned against the number of flags
/// [`producible_cases`] threads through [`role_of`] above.
///
/// A refinement branch added to any `*_role` helper in `roles.rs` adds a
/// gate call to that source text, which this test reads fresh via
/// `include_str!` on every run. That changes the left side of the
/// `assert_eq!` immediately, so the union test above can no longer stay
/// green while `producible_cases` silently omits the new arm - this test
/// fails first and names the fix.
#[test]
fn refinement_gate_flags_in_the_producible_set_match_the_gate_calls_roles_rs_makes() {
    let roles_rs_source = include_str!("roles.rs");
    let gate_calls_in_source = roles_rs_source
        .matches("properties.is_true(TreeProperty::")
        .count()
        + roles_rs_source
            .matches("properties.gated_flag(TreeProperty::")
            .count();

    assert_eq!(
        producible_set_gate_flag_count(),
        gate_calls_in_source,
        "roles.rs's *_role helpers now make a different number of is_true/gated_flag \
         refinement-gate calls than producible_cases() accounts for - add the new gate's \
         ControlType/flag combination to producible_cases() so the union test above \
         actually exercises the role it can now produce, then update FIXTURE_COVERED_ROLES \
         or FIXTURE_UNCOVERED_ROLES to match"
    );
}

#[test]
fn fixture_covered_roles_are_sorted_unique_and_disjoint_from_uncovered() {
    let mut sorted = FIXTURE_COVERED_ROLES.to_vec();
    sorted.sort_unstable();
    sorted.dedup();
    assert_eq!(sorted.as_slice(), FIXTURE_COVERED_ROLES);
    for role in FIXTURE_COVERED_ROLES {
        assert!(
            !FIXTURE_UNCOVERED_ROLES.contains(role),
            "{role} is declared in both FIXTURE_COVERED_ROLES and FIXTURE_UNCOVERED_ROLES"
        );
    }
}

#[test]
fn fixture_uncovered_roles_are_sorted_and_unique() {
    let mut sorted = FIXTURE_UNCOVERED_ROLES.to_vec();
    sorted.sort_unstable();
    sorted.dedup();
    assert_eq!(sorted.as_slice(), FIXTURE_UNCOVERED_ROLES);
}
