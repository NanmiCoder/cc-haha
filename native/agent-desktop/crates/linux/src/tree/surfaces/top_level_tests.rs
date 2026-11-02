use super::*;
use crate::tree::live::test_support::read_of;

#[test]
fn component_root_children_are_top_levels_whatever_their_widget_role() {
    for role in [23, 69, 16, 19, 2, 20, 39, 43, 75] {
        let mut node = read_of(role, "", &[]).node;
        node.traits.interfaces = Field::Present(vec![COMPONENT_INTERFACE.into()]);
        assert!(is_top_level(&node.traits.interfaces), "role {role}");
    }
}

#[test]
fn absent_or_unread_component_evidence_does_not_make_a_top_level() {
    assert!(!is_top_level(&Field::Present(vec![
        "org.a11y.atspi.Action".into()
    ])));
    assert!(!is_top_level(&Field::Present(vec![])));
    assert!(!is_top_level(&Field::Failed("interfaces".into())));
    assert!(!is_top_level(&Field::Absent));
}

#[test]
fn all_atspi_dialog_roles_and_only_those_roles_are_dialogs() {
    for role in [2, 9, 16, 19, 22] {
        assert!(is_dialog_role(Some(&role)), "role {role}");
    }
    for role in [23, 39, 69, 20] {
        assert!(!is_dialog_role(Some(&role)), "role {role}");
    }
    assert!(!is_dialog_role(None));
}

#[test]
fn popup_menu_surfaces_need_positive_complete_menu_child_evidence() {
    use crate::tree::live::test_support::words;
    let mut node = read_of(69, "", &[]).node;
    node.traits.interfaces = Field::Present(vec![COMPONENT_INTERFACE.into()]);
    node.traits.states = Field::Present(words(&[1, SHOWING, 30]));
    for children in [
        vec![(33, vec![])],
        vec![(41, vec![])],
        vec![(34, vec![33])],
        vec![(34, vec![33, 41])],
    ] {
        assert!(is_popup_menu_surface(&node, Some(&children)));
    }
    for children in [
        vec![],
        vec![(43, vec![])],
        vec![(34, vec![])],
        vec![(34, vec![43])],
        vec![(33, vec![]), (43, vec![])],
    ] {
        assert!(!is_popup_menu_surface(&node, Some(&children)));
    }
    assert!(!is_popup_menu_surface(&node, None));
    let children = [(33, vec![])];
    let mut named = node.clone();
    named.properties.name = Field::Present("Document".into());
    assert!(!is_popup_menu_surface(&named, Some(&children)));
    named.properties.name = Field::Failed("name".into());
    assert!(!is_popup_menu_surface(&named, Some(&children)));
    let mut hidden = node.clone();
    hidden.traits.states = Field::Present(words(&[30]));
    assert!(!is_popup_menu_surface(&hidden, Some(&children)));
    node.traits.interfaces = Field::Present(vec![]);
    assert!(!is_popup_menu_surface(&node, Some(&children)));
}
