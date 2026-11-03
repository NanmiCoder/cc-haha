pub(crate) fn ax_role_to_str(ax_role: &str) -> &'static str {
    match ax_role {
        "AXApplication" => "application",
        "AXButton" => "button",
        "AXMenuButton" => "menubutton",
        "AXTextField" | "AXTextArea" | "AXSearchField" | "AXSecureTextField" => "textfield",
        "AXCheckBox" => "checkbox",
        "AXSwitch" | "AXToggle" => "switch",
        "AXLink" => "link",
        "AXMenuItem" | "AXMenuBarItem" => "menuitem",
        "AXRadioButton" => "radiobutton",
        "AXTab" => "tab",
        "AXTabGroup" => "tablist",
        "AXSlider" => "slider",
        "AXValueIndicator" => "handle",
        "AXComboBox" | "AXPopUpButton" => "combobox",
        "AXOutlineRow" => "treeitem",
        "AXRow" => "row",
        "AXCell" => "cell",
        "AXColumn" => "column",
        "AXWindow" => "window",
        "AXSheet" => "sheet",
        "AXDialog" => "dialog",
        "AXGroup" | "AXGenericElement" | "AXSplitGroup" => "group",
        "AXRadioGroup" => "radiogroup",
        "AXToolbar" => "toolbar",
        "AXStaticText" => "statictext",
        "AXImage" => "image",
        "AXTable" => "table",
        "AXList" => "list",
        "AXOutline" => "outline",
        "AXScrollArea" => "scrollarea",
        "AXScrollBar" => "scrollbar",
        "AXSplitter" => "splitter",
        "AXSeparator" => "separator",
        "AXMenu" | "AXMenuBar" => "menu",
        "AXIncrementor" | "AXStepper" => "incrementor",
        "AXDisclosureTriangle" => "disclosure",
        "AXProgressIndicator" | "AXBusyIndicator" => "progressbar",
        "AXColorWell" => "colorwell",
        "AXWebArea" => "webarea",
        "AXBrowser" => "browser",
        "AXGrid" => "grid",
        "AXHandle" => "handle",
        "AXPopover" => "popover",
        "AXDockItem" => "dockitem",
        "AXRuler" => "ruler",
        "AXRulerMarker" => "rulermarker",
        "AXTimeField" => "timefield",
        "AXDateField" => "datefield",
        "AXHelpTag" => "helptag",
        "AXMatte" => "matte",
        "AXDrawer" => "drawer",
        "AXLayoutArea" | "AXLayoutItem" => "layoutitem",
        "AXLevelIndicator" => "levelindicator",
        "AXRelevanceIndicator" => "relevanceindicator",
        "AXDocument" => "document",
        "AXPage" => "page",
        "AXHeading" => "heading",
        "AXParagraph" => "paragraph",
        "AXStatus" => "status",
        "AXToolTip" => "tooltip",
        _ => "unknown",
    }
}

pub(crate) fn ax_role_and_subrole_to_str(ax_role: &str, ax_subrole: Option<&str>) -> &'static str {
    match ax_subrole {
        Some("AXApplicationAlert") => "alert",
        Some("AXApplicationAlertDialog") => "alertdialog",
        Some("AXApplicationDialog") => "dialog",
        Some("AXApplicationLog") => "log",
        Some("AXApplicationMarquee") => "marquee",
        Some("AXApplicationStatus") => "status",
        Some("AXApplicationTimer") => "timer",
        Some("AXDocumentArticle") => "article",
        Some("AXDocumentMath") => "math",
        Some("AXDocumentNote") => "note",
        Some("AXDocumentRegion") => "region",
        Some("AXLandmarkBanner") => "banner",
        Some("AXLandmarkComplementary") => "complementary",
        Some("AXLandmarkContentInfo") => "contentinfo",
        Some("AXLandmarkForm") => "form",
        Some("AXLandmarkMain") => "main",
        Some("AXLandmarkNavigation") => "navigation",
        Some("AXLandmarkSearch") => "search",
        Some("AXDefinition") => "definition",
        Some("AXTerm") => "term",
        Some("AXTabPanel") => "tabpanel",
        Some("AXUserInterfaceTooltip") => "tooltip",
        Some("AXToggleButton") => match ax_role_to_str(ax_role) {
            primary @ ("checkbox" | "switch" | "radiobutton") => primary,
            _ => "button",
        },
        Some("AXOutlineRow") => "treeitem",
        Some("AXTableRow") => "row",
        Some("AXSecureTextField" | "AXSearchField") => "textfield",
        Some("AXDialog" | "AXSystemDialog") => "dialog",
        Some(
            "AXCloseButton" | "AXMinimizeButton" | "AXZoomButton" | "AXToolbarButton"
            | "AXFullScreenButton" | "AXSortButton",
        ) => "button",
        Some("AXToggle" | "AXSwitch") => "switch",
        Some("AXContentList" | "AXDefinitionList" | "AXDescriptionList") => "list",
        Some("AXSeparatorDockItem") => "separator",
        _ => ax_role_to_str(ax_role),
    }
}

pub(crate) use agent_desktop_core::tree::roles::{is_expandable_role, is_toggleable_role};

pub(crate) fn accessible_name_from_subrole(subrole: Option<&str>) -> Option<&'static str> {
    match subrole {
        Some("AXCloseButton") => Some("Close"),
        Some("AXMinimizeButton") => Some("Minimize"),
        Some("AXZoomButton") => Some("Zoom"),
        Some("AXFullScreenButton") => Some("Full Screen"),
        _ => None,
    }
}

#[cfg(test)]
mod tests {
    use super::{accessible_name_from_subrole, ax_role_and_subrole_to_str, ax_role_to_str};

    #[test]
    fn interactive_ax_roles_map_to_exact_normalized_roles() {
        assert_eq!(ax_role_to_str("AXButton"), "button");
        assert_eq!(ax_role_to_str("AXLink"), "link");
        assert_eq!(ax_role_to_str("AXCheckBox"), "checkbox");
        assert_eq!(ax_role_to_str("AXMenuItem"), "menuitem");
        assert_eq!(ax_role_to_str("AXMenuBarItem"), "menuitem");
        assert_eq!(ax_role_to_str("AXScrollArea"), "scrollarea");
        assert_eq!(ax_role_to_str("AXDisclosureTriangle"), "disclosure");
        assert_eq!(ax_role_to_str("AXComboBox"), "combobox");
        assert_eq!(ax_role_to_str("AXColorWell"), "colorwell");
        assert_eq!(ax_role_to_str("AXDockItem"), "dockitem");
    }

    #[test]
    fn native_window_control_subroles_have_accessible_names() {
        assert_eq!(
            accessible_name_from_subrole(Some("AXCloseButton")),
            Some("Close")
        );
        assert_eq!(
            accessible_name_from_subrole(Some("AXMinimizeButton")),
            Some("Minimize")
        );
        assert_eq!(
            accessible_name_from_subrole(Some("AXZoomButton")),
            Some("Zoom")
        );
        assert_eq!(accessible_name_from_subrole(Some("AXButton")), None);
    }

    #[test]
    fn aliased_ax_roles_collapse_to_one_normalized_role() {
        assert_eq!(ax_role_to_str("AXTextField"), "textfield");
        assert_eq!(ax_role_to_str("AXTextArea"), "textfield");
        assert_eq!(ax_role_to_str("AXSearchField"), "textfield");
        assert_eq!(ax_role_to_str("AXSecureTextField"), "textfield");

        assert_eq!(ax_role_to_str("AXSwitch"), "switch");
        assert_eq!(ax_role_to_str("AXToggle"), "switch");

        assert_eq!(ax_role_to_str("AXOutlineRow"), "treeitem");
    }

    #[test]
    fn unknown_ax_role_maps_to_unknown_fallback() {
        assert_eq!(ax_role_to_str("AXCustomWidget"), "unknown");
        assert_eq!(ax_role_to_str(""), "unknown");
        assert_eq!(ax_role_to_str("button"), "unknown");
    }

    #[test]
    fn every_emitted_role_is_in_the_core_vocabulary() {
        for native in [
            "AXApplication",
            "AXButton",
            "AXTextField",
            "AXCheckBox",
            "AXSwitch",
            "AXLink",
            "AXMenuItem",
            "AXRadioButton",
            "AXTab",
            "AXTabGroup",
            "AXSlider",
            "AXValueIndicator",
            "AXComboBox",
            "AXOutlineRow",
            "AXRow",
            "AXCell",
            "AXColumn",
            "AXWindow",
            "AXSheet",
            "AXDialog",
            "AXGroup",
            "AXToolbar",
            "AXStaticText",
            "AXImage",
            "AXTable",
            "AXList",
            "AXOutline",
            "AXScrollArea",
            "AXScrollBar",
            "AXSplitter",
            "AXSplitGroup",
            "AXSeparator",
            "AXMenu",
            "AXIncrementor",
            "AXDisclosureTriangle",
            "AXProgressIndicator",
            "AXColorWell",
            "AXWebArea",
            "AXBrowser",
            "AXGrid",
            "AXHandle",
            "AXPopover",
            "AXDockItem",
            "AXRuler",
            "AXRulerMarker",
            "AXTimeField",
            "AXDateField",
            "AXHelpTag",
            "AXMatte",
            "AXDrawer",
            "AXLayoutArea",
            "AXLevelIndicator",
            "AXRelevanceIndicator",
            "AXDocument",
            "AXPage",
            "AXHeading",
            "AXParagraph",
            "AXStatus",
            "AXToolTip",
        ] {
            assert!(
                agent_desktop_core::tree::roles::is_canonical_role(ax_role_to_str(native)),
                "{native} emitted a noncanonical role"
            );
        }
    }

    #[test]
    fn container_and_control_roles_do_not_collapse_into_interactive_siblings() {
        assert_eq!(ax_role_to_str("AXTabGroup"), "tablist");
        assert_eq!(ax_role_to_str("AXTab"), "tab");
        assert_eq!(ax_role_to_str("AXRow"), "row");
        assert_eq!(ax_role_to_str("AXOutlineRow"), "treeitem");
        assert_eq!(ax_role_to_str("AXValueIndicator"), "handle");
        assert_eq!(ax_role_to_str("AXSlider"), "slider");
        assert_eq!(ax_role_to_str("AXScrollBar"), "scrollbar");
        assert_eq!(ax_role_to_str("AXScrollArea"), "scrollarea");
        assert_eq!(ax_role_to_str("AXSplitGroup"), "group");
        assert_eq!(ax_role_to_str("AXSplitter"), "splitter");
    }

    #[test]
    fn subroles_preserve_semantics_hidden_by_generic_native_roles() {
        assert_eq!(
            ax_role_and_subrole_to_str("AXRow", Some("AXOutlineRow")),
            "treeitem"
        );
        assert_eq!(
            ax_role_and_subrole_to_str("AXRow", Some("AXTableRow")),
            "row"
        );
        assert_eq!(
            ax_role_and_subrole_to_str("AXWindow", Some("AXDialog")),
            "dialog"
        );
        assert_eq!(
            ax_role_and_subrole_to_str("AXTextField", Some("AXSecureTextField")),
            "textfield"
        );
        assert_eq!(
            ax_role_and_subrole_to_str("AXDockItem", Some("AXSeparatorDockItem")),
            "separator"
        );
    }

    #[test]
    fn button_subrole_does_not_erase_a_primary_checkbox_role() {
        assert_eq!(
            ax_role_and_subrole_to_str("AXCheckBox", Some("AXToggleButton")),
            "checkbox"
        );
        assert_eq!(
            ax_role_and_subrole_to_str("AXButton", Some("AXToggleButton")),
            "button"
        );
        assert_eq!(
            ax_role_and_subrole_to_str("AXSwitch", Some("AXToggleButton")),
            "switch"
        );
        assert_eq!(
            ax_role_and_subrole_to_str("AXRadioButton", Some("AXToggleButton")),
            "radiobutton"
        );
    }

    #[test]
    fn chromium_subroles_preserve_web_semantics_hidden_by_ax_group() {
        let mappings = [
            ("AXApplicationAlert", "alert"),
            ("AXApplicationAlertDialog", "alertdialog"),
            ("AXApplicationDialog", "dialog"),
            ("AXApplicationLog", "log"),
            ("AXApplicationMarquee", "marquee"),
            ("AXApplicationStatus", "status"),
            ("AXApplicationTimer", "timer"),
            ("AXDocumentArticle", "article"),
            ("AXDocumentMath", "math"),
            ("AXDocumentNote", "note"),
            ("AXDocumentRegion", "region"),
            ("AXLandmarkBanner", "banner"),
            ("AXLandmarkComplementary", "complementary"),
            ("AXLandmarkContentInfo", "contentinfo"),
            ("AXLandmarkForm", "form"),
            ("AXLandmarkMain", "main"),
            ("AXLandmarkNavigation", "navigation"),
            ("AXLandmarkSearch", "search"),
            ("AXDefinition", "definition"),
            ("AXTerm", "term"),
            ("AXTabPanel", "tabpanel"),
            ("AXUserInterfaceTooltip", "tooltip"),
            ("AXToggleButton", "button"),
        ];

        for (subrole, expected) in mappings {
            let mapped = ax_role_and_subrole_to_str("AXGroup", Some(subrole));
            assert_eq!(mapped, expected, "unexpected mapping for {subrole}");
            assert!(agent_desktop_core::tree::roles::is_canonical_role(mapped));
        }
    }
}
