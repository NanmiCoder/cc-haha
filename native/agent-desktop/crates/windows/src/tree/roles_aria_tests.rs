use agent_desktop_core::tree::roles::{is_valid_role_query, normalize_role_query};

use super::{ControlType, TreeProperty, flag, role_of};

/// `menubar` is the one substitution this test adds beyond core's own alias
/// table: Microsoft's ARIA table maps `menubar` onto the `MenuBar` control
/// type, but core's `Role` vocabulary has no distinct menu-bar role, only
/// `menu` - the same vocabulary this map's settled table already collapses
/// `Menu` and `MenuBar` onto. Every other name goes through core's own
/// `normalize_role_query`, so this function makes no naming decision core
/// does not already make.
fn normalize_for_containment(aria_role: &str) -> String {
    if aria_role == "menubar" {
        return "menu".to_string();
    }
    if is_valid_role_query(aria_role) {
        normalize_role_query(aria_role)
    } else {
        aria_role.to_string()
    }
}

fn assert_in_aria_set(role: &str, label: &str, admissible: &[&str]) {
    let normalized: Vec<String> = admissible
        .iter()
        .map(|name| normalize_for_containment(name))
        .collect();
    assert!(
        normalized.iter().any(|candidate| candidate == role),
        "{label} role {role:?} is not a member of its ARIA-admissible set {normalized:?}"
    );
}

/// Transcribed from Microsoft's published ARIA-role-to-UI-Automation-control-type
/// table (`learn.microsoft.com/windows/win32/winauto/uiauto-ariaspecification`,
/// "W3C ARIA Role Mapped to Microsoft Active Accessibility and UI Automation"),
/// inverted so each control type carries the set of ARIA role names that
/// target it - never transcribed from this crate's own map.
///
/// `Custom`, `TitleBar`, `SemanticZoom`, `Calendar`, `Thumb`, `Window`,
/// `Header`, `HeaderItem` and `AppBar` never appear as a target in that
/// table. Neither do `Edit`, `SplitButton` or `Table` - the published table
/// predates the `textbox`-as-`Edit`, `SplitButton` and plain `Table`
/// conventions and never grew a row for them - so all twelve are exempt from
/// this assertion.
///
/// Two covered control types are exempt by name rather than by silent
/// omission. `Text`'s default `statictext` and `Pane`'s default `group` are
/// this map's generic fallback for the overwhelmingly common case - plain
/// text with no semantic role, a plain non-dialog container - and neither
/// fallback is a member of its control type's ARIA set: the table only lists
/// the semantic overlays (`alert`/`description`/`heading`/`marquee` for
/// `Text`; `presentation`/`region`/etc. for `Pane`) that happen to share a
/// UIA control type with the generic case, because a plain text node or a
/// plain container carries no ARIA role of its own to begin with. Both
/// defaults are still exercised by `every_emitted_role_is_in_the_core_vocabulary`
/// in the parent module.
#[test]
fn map_targets_are_members_of_their_aria_admissible_set() {
    let selectable = vec![flag(TreeProperty::SelectionAvailable, true)];
    let grid_item = vec![flag(TreeProperty::GridItemAvailable, true)];
    let editable = vec![
        flag(TreeProperty::ValueAvailable, true),
        flag(TreeProperty::ValueIsReadOnly, false),
    ];
    let dialog_pane = vec![flag(TreeProperty::WindowAvailable, true)];
    let group_aria: &[&str] = &[
        "banner",
        "complementary",
        "contentinfo",
        "definition",
        "form",
        "group",
        "log",
        "main",
        "navigation",
        "note",
        "radiogroup",
        "search",
        "section",
    ];
    let pane_aria: &[&str] = &[
        "alertdialog",
        "application",
        "dialog",
        "presentation",
        "region",
        "tabpanel",
        "timer",
    ];
    let data_item_aria: &[&str] = &["columnheader", "gridcell", "row", "rowheader"];
    let document_aria: &[&str] = &["article", "document", "textbox"];

    let cases: Vec<(&str, String, &[&str])> = vec![
        (
            "Button",
            role_of(ControlType::Button, Vec::new()),
            &["button"],
        ),
        (
            "CheckBox",
            role_of(ControlType::CheckBox, Vec::new()),
            &["checkbox", "menuitemcheckbox"],
        ),
        (
            "ComboBox",
            role_of(ControlType::ComboBox, Vec::new()),
            &["combobox"],
        ),
        (
            "Hyperlink",
            role_of(ControlType::Hyperlink, Vec::new()),
            &["link"],
        ),
        ("Image", role_of(ControlType::Image, Vec::new()), &["img"]),
        (
            "ListItem",
            role_of(ControlType::ListItem, Vec::new()),
            &["listitem", "option"],
        ),
        (
            "List (plain)",
            role_of(ControlType::List, Vec::new()),
            &["directory", "list", "listbox"],
        ),
        (
            "List (selectable)",
            role_of(ControlType::List, selectable),
            &["directory", "list", "listbox"],
        ),
        ("Menu", role_of(ControlType::Menu, Vec::new()), &["menu"]),
        (
            "MenuBar",
            role_of(ControlType::MenuBar, Vec::new()),
            &["menubar"],
        ),
        (
            "MenuItem",
            role_of(ControlType::MenuItem, Vec::new()),
            &["menuitem"],
        ),
        (
            "ProgressBar",
            role_of(ControlType::ProgressBar, Vec::new()),
            &["progressbar"],
        ),
        (
            "RadioButton",
            role_of(ControlType::RadioButton, Vec::new()),
            &["radio", "menuitemradio"],
        ),
        (
            "ScrollBar",
            role_of(ControlType::ScrollBar, Vec::new()),
            &["scrollbar"],
        ),
        (
            "Slider",
            role_of(ControlType::Slider, Vec::new()),
            &["slider"],
        ),
        (
            "Spinner",
            role_of(ControlType::Spinner, Vec::new()),
            &["spinbutton"],
        ),
        (
            "StatusBar",
            role_of(ControlType::StatusBar, Vec::new()),
            &["status"],
        ),
        ("Tab", role_of(ControlType::Tab, Vec::new()), &["tablist"]),
        (
            "TabItem",
            role_of(ControlType::TabItem, Vec::new()),
            &["tab"],
        ),
        (
            "ToolBar",
            role_of(ControlType::ToolBar, Vec::new()),
            &["toolbar"],
        ),
        (
            "ToolTip",
            role_of(ControlType::ToolTip, Vec::new()),
            &["tooltip"],
        ),
        ("Tree", role_of(ControlType::Tree, Vec::new()), &["tree"]),
        (
            "TreeItem",
            role_of(ControlType::TreeItem, Vec::new()),
            &["treeitem"],
        ),
        ("Group", role_of(ControlType::Group, Vec::new()), group_aria),
        (
            "DataGrid",
            role_of(ControlType::DataGrid, Vec::new()),
            &["grid", "treegrid"],
        ),
        (
            "DataItem (grid item)",
            role_of(ControlType::DataItem, grid_item),
            data_item_aria,
        ),
        (
            "DataItem (plain)",
            role_of(ControlType::DataItem, Vec::new()),
            data_item_aria,
        ),
        (
            "Document (editable)",
            role_of(ControlType::Document, editable),
            document_aria,
        ),
        (
            "Document (plain)",
            role_of(ControlType::Document, Vec::new()),
            document_aria,
        ),
        (
            "Pane (dialog)",
            role_of(ControlType::Pane, dialog_pane),
            pane_aria,
        ),
        (
            "Separator",
            role_of(ControlType::Separator, Vec::new()),
            &["separator"],
        ),
    ];

    for (label, role, admissible) in cases {
        assert_in_aria_set(&role, label, admissible);
    }
}
