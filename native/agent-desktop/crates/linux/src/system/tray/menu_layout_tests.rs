use super::*;

fn raw(id: i32, props: &[(&str, Prop)], children: Vec<RawEntry>) -> RawEntry {
    RawEntry {
        id,
        props: props
            .iter()
            .map(|(key, value)| ((*key).to_owned(), value.clone()))
            .collect(),
        children,
    }
}

fn text(value: &str) -> Prop {
    Prop::Text(value.into())
}

fn sample() -> RawEntry {
    raw(
        0,
        &[("children-display", text("submenu"))],
        vec![
            raw(1, &[("label", text("_Open L21"))], vec![]),
            raw(2, &[("type", text("separator"))], vec![]),
            raw(
                3,
                &[("label", text("Disabled")), ("enabled", Prop::Flag(false))],
                vec![],
            ),
            raw(
                4,
                &[
                    ("label", text("Check")),
                    ("toggle-type", text("checkmark")),
                    ("toggle-state", Prop::Number(1)),
                ],
                vec![],
            ),
            raw(
                5,
                &[
                    ("label", text("More")),
                    ("children-display", text("submenu")),
                ],
                vec![raw(6, &[("label", text("Child"))], vec![])],
            ),
            raw(
                7,
                &[("label", text("Hidden")), ("visible", Prop::Flag(false))],
                vec![],
            ),
        ],
    )
}

#[test]
fn entries_keep_their_ids_order_and_stripped_labels() {
    let layout = parse(&sample());
    let labels: Vec<&str> = layout
        .root
        .children
        .iter()
        .map(|c| c.label.as_str())
        .collect();
    assert_eq!(labels, ["Open L21", "", "Disabled", "Check", "More"]);
    assert_eq!(layout.root.children[0].id, 1);
}

#[test]
fn an_entry_is_enabled_unless_it_says_otherwise() {
    let layout = parse(&sample());
    assert!(layout.root.children[0].enabled);
    assert!(!layout.root.children[2].enabled);
}

#[test]
fn a_separator_is_recognised_by_its_type() {
    let layout = parse(&sample());
    assert!(layout.root.children[1].separator);
    assert!(!layout.root.children[0].separator);
}

#[test]
fn a_checkable_entry_reads_its_toggle_state_and_a_plain_one_has_none() {
    let layout = parse(&sample());
    assert_eq!(layout.root.children[3].checked, Some(true));
    assert_eq!(layout.root.children[0].checked, None);
}

#[test]
fn a_submenu_parent_is_marked_and_keeps_its_child() {
    let layout = parse(&sample());
    let more = &layout.root.children[4];
    assert!(more.submenu);
    assert_eq!(more.children.len(), 1);
    assert_eq!(more.children[0].label, "Child");
}

#[test]
fn mnemonic_underscores_are_removed_and_doubled_ones_kept() {
    assert_eq!(strip_mnemonic("_File"), "File");
    assert_eq!(strip_mnemonic("Save __As"), "Save _As");
    assert_eq!(strip_mnemonic("plain"), "plain");
    assert_eq!(strip_mnemonic("trailing_"), "trailing");
}
