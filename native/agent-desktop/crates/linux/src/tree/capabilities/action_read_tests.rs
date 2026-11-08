use super::{NodeView, corroboration_of};
use crate::actions::write::mutation::Corroboration;
use crate::system::NAME_HAS_NO_OWNER;
use crate::tree::capabilities::value_read::ValueRead;
use crate::tree::live::test_support::{client_timeout, method_error, read_of, words};
use crate::tree::observe::node_evidence::{NodeEvidence, evidence_for};
use crate::tree::properties::absence::{UNKNOWN_INTERFACE, UNKNOWN_OBJECT};
use crate::tree::properties::liveness::Liveness;
use crate::tree::vocabulary::role_numbers::{PASSWORD_TEXT, PUSH_BUTTON, TOGGLE_BUTTON};
use crate::tree::vocabulary::state_bits::{CHECKED, EXPANDED, FOCUSED, PRESSED, SELECTED, SHOWING};
use crate::tree::{Field, ObservedRead};

fn view_of(read: ObservedRead) -> NodeView {
    let evidence = evidence_for(&read, &read.node.element);
    NodeView::new(NodeEvidence {
        read,
        evidence,
        liveness: Liveness::Alive,
    })
}

fn with_bits(role: u32, bits: &[u32]) -> NodeView {
    let mut read = read_of(role, "Wrap", &["click"]);
    read.node.traits.states = Field::Present(words(bits));
    view_of(read)
}

#[test]
fn absent_and_failed_reads_remain_distinct() {
    let mut absent = read_of(PUSH_BUTTON, "n", &[]);
    absent.node.actions = Field::Absent;
    let absent = view_of(absent);
    assert_eq!(absent.action_names(), Some(&[][..]));

    let mut failed = read_of(PUSH_BUTTON, "n", &[]);
    failed.node.actions = Field::Failed("actions unavailable".to_owned());
    assert_eq!(view_of(failed).action_names(), None);
    let mut failed_states = read_of(PUSH_BUTTON, "n", &[]);
    failed_states.node.traits.states = Field::Failed("states unavailable".to_owned());
    let failed_states = view_of(failed_states);
    assert_eq!(failed_states.state(CHECKED), None);
    assert_eq!(failed_states.tokens(), None);
}

#[test]
fn secure_fields_withhold_values_and_truncated_values_are_not_values() {
    let mut password = read_of(PASSWORD_TEXT, "Password", &[]);
    password.value.value = Field::Present("sensitive".to_owned());
    let password = view_of(password);
    assert!(password.secure());
    assert_eq!(password.value(), None);
    assert_eq!(
        password
            .observation()
            .changed_since(&password.observation()),
        None
    );
    assert!(with_bits(PASSWORD_TEXT, &[SHOWING]).secure());

    let mut unread_states = read_of(PUSH_BUTTON, "n", &[]);
    unread_states.node.traits.states = Field::Failed("unavailable".to_owned());
    assert!(view_of(unread_states).secure());
    let mut unread_role = read_of(PUSH_BUTTON, "n", &[]);
    unread_role.node.traits.role = Field::Failed("unavailable".to_owned());
    assert!(view_of(unread_role).secure());

    let mut truncated = read_of(PUSH_BUTTON, "n", &[]);
    truncated.value = ValueRead {
        value: Field::Present("prefix".to_owned()),
        truncated: true,
    };
    assert_eq!(view_of(truncated).value(), None);
}

#[test]
fn observations_report_only_shared_differences_and_keep_unread_indeterminate() {
    let base = read_of(PUSH_BUTTON, "n", &[]);
    let before = view_of(base.clone()).observation();
    let mut cases = Vec::new();

    let mut checked = base.clone();
    checked.node.traits.role = Field::Present(TOGGLE_BUTTON);
    checked.node.traits.states = Field::Present(words(&[CHECKED]));
    cases.push(("checked", checked));
    let mut expanded = base.clone();
    expanded.node.traits.states = Field::Present(words(&[EXPANDED]));
    cases.push(("expanded", expanded));
    let mut selected = base.clone();
    selected.node.traits.states = Field::Present(words(&[SELECTED]));
    cases.push(("selected", selected));
    let mut pressed = base.clone();
    pressed.node.traits.states = Field::Present(words(&[PRESSED]));
    cases.push(("pressed", pressed));
    let mut valued = base.clone();
    valued.value.value = Field::Present("1".to_owned());
    cases.push(("value", valued));
    let mut renamed = base.clone();
    renamed.node.properties.name = Field::Present("m".to_owned());
    cases.push(("name", renamed));
    let mut grown = base.clone();
    grown.node.properties.child_count = Field::Present(2);
    cases.push(("child count", grown));

    for (part, changed) in cases {
        assert_eq!(
            view_of(changed).observation().changed_since(&before),
            Some(true),
            "{part}"
        );
    }
    let focused = with_bits(PUSH_BUTTON, &[SHOWING, FOCUSED]).observation();
    let shown = with_bits(PUSH_BUTTON, &[SHOWING]).observation();
    assert_eq!(focused.changed_since(&shown), Some(false));

    let mut unread = read_of(PUSH_BUTTON, "n", &[]);
    unread.node.traits.states = Field::Failed("states unavailable".to_owned());
    assert_eq!(view_of(unread).observation().changed_since(&before), None);
    let mut decided = read_of(PUSH_BUTTON, "n", &[]);
    decided.node.traits.states = Field::Failed("states unavailable".to_owned());
    decided.node.properties.name = Field::Present("other".to_owned());
    assert_eq!(
        view_of(decided).observation().changed_since(&before),
        Some(true)
    );
}

#[test]
fn corroboration_distinguishes_dead_timed_out_and_unread_nodes() {
    assert_eq!(corroboration_of(None), Corroboration::Alive);
    for name in [UNKNOWN_OBJECT, UNKNOWN_INTERFACE, NAME_HAS_NO_OWNER] {
        assert_eq!(
            corroboration_of(Some(&method_error(name))),
            Corroboration::Dead,
            "{name}"
        );
    }
    assert_eq!(
        corroboration_of(Some(&client_timeout())),
        Corroboration::TimedOut
    );
    assert_eq!(
        corroboration_of(Some(&method_error("org.freedesktop.DBus.Error.Failed"))),
        Corroboration::NotRead
    );
}
