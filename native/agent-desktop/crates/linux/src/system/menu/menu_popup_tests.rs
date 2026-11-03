use super::{MenuFamily, in_window, popup_roots, top_level};
use crate::system::menu::menu_fixture::*;

fn families(found: &[super::Found<'_>]) -> Vec<MenuFamily> {
    found.iter().map(|popup| popup.family).collect()
}

#[test]
fn a_checked_menu_toggle_exposes_its_direct_showing_items_as_a_popup() {
    for (states, showing, expected) in [
        (vec![SHOWING, CHECKED], true, true),
        (vec![SHOWING], true, false),
        (vec![CHECKED], true, false),
        (vec![SHOWING, CHECKED], false, false),
    ] {
        let frame = frame_with(vec![node(TOGGLE, "Menu", &states, items(showing))]);
        let found = in_window(&frame);
        assert_eq!(!found.is_empty(), expected);
        if expected {
            assert_eq!(families(&found), [MenuFamily::Gtk3Popover]);
            assert_eq!(found[0].items, 2);
        }
    }
    let frame = frame_with(vec![node(
        TOGGLE,
        "Other toggle",
        &[SHOWING, CHECKED],
        vec![
            item("Open", true),
            node(BUTTON, "Ordinary button", &[SHOWING], vec![]),
        ],
    )]);
    assert!(in_window(&frame).is_empty());
}

#[test]
fn a_gtk4_popover_inside_the_frame_is_one_popup_rooted_at_its_menu() {
    let frame = frame_with(vec![node(PANEL, "", &[SHOWING], vec![gtk4_popover(true)])]);
    let found = in_window(&frame);
    assert_eq!(families(&found), [MenuFamily::Gtk4Popover]);
    assert_eq!(found[0].items, 2);
    assert_eq!(
        found[0]
            .root
            .payload
            .node
            .properties
            .name
            .present()
            .map(String::as_str),
        Some("Main Menu")
    );
}

#[test]
fn a_gtk3_menu_bar_whose_items_show_is_open_and_one_whose_items_do_not_is_not() {
    let open = frame_with(vec![gtk3_bar(true)]);
    assert_eq!(families(&in_window(&open)), [MenuFamily::Gtk3Bar]);
    let idle = frame_with(vec![gtk3_bar(false)]);
    assert!(in_window(&idle).is_empty());
}

#[test]
fn a_qt_popup_is_open_only_while_its_items_show() {
    let open = frame_with(vec![qt_bar(true)]);
    let found = in_window(&open);
    assert_eq!(families(&found), [MenuFamily::Qt]);
    assert_eq!(found[0].items, 2);
    let closed = frame_with(vec![qt_bar(false)]);
    assert!(in_window(&closed).is_empty());
}

#[test]
fn menu_bar_items_that_always_show_are_not_a_popup() {
    let bar_only = node(
        MENU_BAR,
        "",
        &[SHOWING],
        vec![item("File", true), item("Edit", true)],
    );
    assert!(in_window(&frame_with(vec![bar_only])).is_empty());
}

#[test]
fn a_button_that_advertises_a_popup_is_not_a_popup() {
    let button = node(BUTTON, "Menu", &[SHOWING, HAS_POPUP], Vec::new());
    assert!(in_window(&frame_with(vec![button])).is_empty());
}

#[test]
fn a_menu_inside_a_web_document_is_not_a_popup() {
    let mut aria = gtk4_popover(true);
    aria.in_web_document = true;
    assert!(in_window(&frame_with(vec![aria])).is_empty());
    let document = node(DOCUMENT_WEB, "page", &[SHOWING], vec![gtk4_popover(true)]);
    assert!(in_window(&frame_with(vec![document])).is_empty());
}

#[test]
fn a_submenu_chain_lists_the_outer_popup_first() {
    let inner = node(MENU, "More", &[SHOWING], items(true));
    let more = node(ITEM, "More", &[SHOWING], vec![inner]);
    let outer = node(MENU, "File", &[SHOWING], vec![item("Open", true), more]);
    let bar = node(MENU_BAR, "", &[SHOWING], vec![outer]);
    let frame = frame_with(vec![bar]);
    let found = in_window(&frame);
    let names: Vec<&str> = found
        .iter()
        .filter_map(|popup| popup.root.payload.node.properties.name.present())
        .map(String::as_str)
        .collect();
    assert_eq!(names, ["File", "More"]);
}

#[test]
fn check_menu_items_count_toward_the_items_of_a_popup() {
    let checks = node(
        MENU,
        "View",
        &[SHOWING],
        vec![
            node(CHECK_ITEM, "Wrap", &[SHOWING], Vec::new()),
            node(SEPARATOR, "", &[SHOWING], Vec::new()),
        ],
    );
    let frame = frame_with(vec![checks]);
    let found = in_window(&frame);
    assert_eq!(found[0].items, 1);
}

#[test]
fn a_nameless_top_level_window_holding_a_menu_is_a_gtk3_context_popup() {
    let window = gtk3_context_window();
    let found = top_level(&window).expect("a popup");
    assert_eq!(found.family, MenuFamily::Gtk3Context);
    assert_eq!(found.root.payload.node.traits.role.present(), Some(&MENU));
    assert_eq!(found.items, 2);
}

#[test]
fn a_nameless_top_level_frame_holding_a_menu_bar_menu_is_a_chromium_popup() {
    let frame = chromium_frame();
    let found = top_level(&frame).expect("a popup");
    assert_eq!(found.family, MenuFamily::Chromium);
    assert_eq!(found.root.payload.node.traits.role.present(), Some(&MENU));
}

#[test]
fn a_titled_window_or_one_with_other_content_is_not_a_popup() {
    let mut named = gtk3_context_window();
    named.payload.node.properties.name = crate::tree::Field::Present("Settings".to_owned());
    assert!(top_level(&named).is_none());
    let with_label = node(
        WINDOW,
        "",
        &[SHOWING],
        vec![
            gtk4_popover(true),
            node(LABEL, "hello", &[SHOWING], Vec::new()),
        ],
    );
    assert!(top_level(&with_label).is_none());
}

#[test]
fn a_hidden_top_level_window_or_one_with_closed_items_is_not_a_popup() {
    let mut hidden = gtk3_context_window();
    hidden.payload.node.traits.states =
        crate::tree::Field::Present(crate::tree::live::test_support::words(&[]));
    assert!(top_level(&hidden).is_none());
    let closed = node(
        WINDOW,
        "",
        &[SHOWING],
        vec![node(MENU, "", &[SHOWING], items(false))],
    );
    assert!(top_level(&closed).is_none());
}

#[test]
fn a_menu_that_does_not_show_is_not_open_though_its_items_do() {
    let menu = node(MENU, "File", &[], items(true));
    assert!(in_window(&frame_with(vec![menu])).is_empty());
}

#[test]
fn a_checked_toggle_with_a_modal_showing_panel_of_buttons_is_a_gtk3_popover() {
    let frame = frame_with(vec![header_toggle(true), header_popover_panel(true)]);
    let found = in_window(&frame);
    assert_eq!(families(&found), [MenuFamily::Gtk3Popover]);
    assert_eq!(found[0].items, 2);
}

#[test]
fn a_gtk3_popover_with_the_toggle_clear_is_closed() {
    let frame = frame_with(vec![header_toggle(false), header_popover_panel(false)]);
    assert!(in_window(&frame).is_empty());
}

#[test]
fn the_toggle_alone_is_not_a_popover() {
    let frame = frame_with(vec![header_toggle(true)]);
    assert!(in_window(&frame).is_empty());
}

#[test]
fn a_modal_panel_without_the_checked_toggle_is_a_dialog_and_not_a_menu() {
    let frame = frame_with(vec![header_toggle(false), header_popover_panel(true)]);
    assert!(in_window(&frame).is_empty());
}

#[test]
fn a_checked_toggle_with_a_panel_that_is_not_modal_is_not_a_popover() {
    let panel = node(
        PANEL,
        "",
        &[SHOWING],
        vec![node(BUTTON, "Go", &[SHOWING], Vec::new())],
    );
    let frame = frame_with(vec![header_toggle(true), panel]);
    assert!(in_window(&frame).is_empty());
}

#[test]
fn a_menu_found_by_another_rule_hides_the_popover_rule() {
    let frame = frame_with(vec![
        header_toggle(true),
        header_popover_panel(true),
        gtk3_bar(true),
    ]);
    assert_eq!(families(&in_window(&frame)), [MenuFamily::Gtk3Bar]);
}

#[test]
fn menu_regression_expanded_popup_button_exposes_its_showing_panel() {
    use crate::tree::vocabulary::state_bits::{EXPANDED, PRESSED};
    let panel = node(
        PANEL,
        "",
        &[SHOWING],
        vec![node(BUTTON, "Browse", &[SHOWING], vec![])],
    );
    let inner = node(TOGGLE, "Open", &[SHOWING, PRESSED], vec![]);
    let mut opener = node(
        BUTTON,
        "Open",
        &[SHOWING, HAS_POPUP, EXPANDED],
        vec![inner, panel],
    );
    let found = in_window(&opener);
    assert_eq!(families(&found), [MenuFamily::Gtk4Popover]);
    assert_eq!(
        found[0].root.payload.node.traits.role.present(),
        Some(&PANEL)
    );
    assert_eq!(found[0].items, 1);
    opener.children.pop();
    assert!(
        in_window(&opener).is_empty(),
        "pressed/expanded alone proves no popup"
    );
    opener.children.push(node(
        PANEL,
        "",
        &[],
        vec![node(BUTTON, "Browse", &[SHOWING], vec![])],
    ));
    assert!(
        in_window(&opener).is_empty(),
        "a hidden panel is not an open popup"
    );
}

#[test]
fn an_expanded_menu_button_whose_popover_shows_only_a_label_has_that_popover_as_its_popup() {
    let opener = label_popover_opener(true);
    let roots = popup_roots(&opener);
    assert_eq!(roots.len(), 1);
    assert_eq!(roots[0].payload.node.traits.role.present(), Some(&PANEL));
    assert!(
        in_window(&opener).is_empty(),
        "a popover with no menu content is no menu surface"
    );
}

#[test]
fn a_menu_found_by_a_menu_rule_keeps_its_own_roots() {
    use crate::tree::vocabulary::state_bits::{EXPANDED, PRESSED};
    let panel = node(PANEL, "", &[SHOWING], vec![gtk4_popover(true)]);
    let inner = node(TOGGLE, "Open", &[SHOWING, PRESSED], vec![]);
    let opener = node(
        BUTTON,
        "Open",
        &[SHOWING, HAS_POPUP, EXPANDED],
        vec![inner, panel],
    );
    let fallback = super::opened_button_popover(&opener).expect("the button's showing panel");
    let roots = popup_roots(&opener);
    assert_eq!(roots.len(), 1);
    assert_eq!(roots[0].payload.node.traits.role.present(), Some(&MENU));
    assert_eq!(
        roots[0]
            .payload
            .node
            .properties
            .name
            .present()
            .map(String::as_str),
        Some("Main Menu")
    );
    assert!(!std::ptr::eq(roots[0], fallback));
}

#[test]
fn a_label_popover_is_a_popup_only_while_the_whole_topology_shows() {
    use crate::tree::Field;
    use crate::tree::live::test_support::words;
    use crate::tree::vocabulary::state_bits::EXPANDED;
    assert!(
        popup_roots(&label_popover_opener(false)).is_empty(),
        "a popover that does not show is closed"
    );
    let mut unpressed = label_popover_opener(true);
    unpressed.children[0].payload.node.traits.states = Field::Present(words(&[SHOWING]));
    assert!(
        popup_roots(&unpressed).is_empty(),
        "an unpressed toggle proves no open popover"
    );
    let mut collapsed = label_popover_opener(true);
    collapsed.payload.node.traits.states = Field::Present(words(&[SHOWING, HAS_POPUP]));
    assert!(
        popup_roots(&collapsed).is_empty(),
        "a button that is not expanded has no open popover"
    );
    let mut unexpandable = label_popover_opener(true);
    unexpandable.payload.node.traits.states = Field::Present(words(&[SHOWING, EXPANDED]));
    assert!(
        popup_roots(&unexpandable).is_empty(),
        "a button that advertises no popup has no popover"
    );
    let mut twin = label_popover_opener(true);
    twin.children.push(node(
        PANEL,
        "",
        &[SHOWING],
        vec![node(LABEL, "x", &[SHOWING], vec![])],
    ));
    assert!(
        popup_roots(&twin).is_empty(),
        "two showing panels name no single popover"
    );
}

#[test]
fn popup_admission_uses_menu_children_and_component_evidence_instead_of_the_root_role() {
    use crate::tree::Field;
    let mut popup = gtk3_context_window();
    popup.payload.node.traits.role = Field::Present(BUTTON);
    assert_eq!(top_level(&popup).unwrap().items, 2);
    popup.payload.node.traits.interfaces = Field::Present(vec![]);
    assert!(top_level(&popup).is_none());
    popup.payload.node.traits.interfaces = Field::Failed("interfaces".into());
    assert!(top_level(&popup).is_none());
}

#[test]
fn unread_or_partial_popup_children_do_not_establish_a_menu_surface() {
    use crate::tree::Field;
    let mut unread = gtk3_context_window();
    unread.children[0].payload.node.traits.role = Field::Failed("role".into());
    assert!(top_level(&unread).is_none());
    let mut partial = chromium_frame();
    partial.children[0].truncated = true;
    assert!(top_level(&partial).is_none());
    let mut missing = gtk3_context_window();
    missing.child_count = Some(2);
    assert!(top_level(&missing).is_none());
}
