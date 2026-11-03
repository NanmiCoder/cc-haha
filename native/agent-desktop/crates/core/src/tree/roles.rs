/// Interactive roles that receive refs during snapshot allocation.
///
/// Each entry must be produced by at least one platform adapter's native-to-canonical
/// role mapping. Read-only roles (statictext, image) and container roles (group, list,
/// table) stay out. Platform-private extensions live in the adapter, not here.
pub const INTERACTIVE_ROLES: &[&str] = &[
    "button",
    "cell",
    "checkbox",
    "colorwell",
    "combobox",
    "dockitem",
    "incrementor",
    "link",
    "listbox",
    "menubutton",
    "menuitem",
    "option",
    "radiobutton",
    "slider",
    "switch",
    "tab",
    "textfield",
    "treeitem",
];

/// Normalizes a caller-supplied role filter for comparison against tree
/// roles: trims, lowercases, and folds a few high-frequency web-automation
/// synonyms onto their canonical names so an agent's reflexive `textarea`
/// matches the `textfield` the adapters emit. Callers must validate with
/// [`is_valid_role_query`] before normalizing.
pub fn normalize_role_query(role: &str) -> String {
    let normalized = role.trim().to_ascii_lowercase();
    let canonical =
        role_query_alias(&normalized).unwrap_or_else(|| crate::Role::from_token(&normalized));
    canonical.as_str().to_string()
}

pub fn is_valid_role_query(role: &str) -> bool {
    let normalized = role.trim().to_ascii_lowercase();
    role_query_alias(&normalized).is_some()
        || (normalized != "unknown" && crate::Role::is_canonical(&normalized))
}

fn role_query_alias(role: &str) -> Option<crate::Role> {
    match role {
        "gridcell" => Some(crate::Role::Cell),
        "img" => Some(crate::Role::Image),
        "radio" => Some(crate::Role::RadioButton),
        "searchbox" | "searchfield" | "textarea" | "textbox" => Some(crate::Role::TextField),
        "spinbutton" => Some(crate::Role::Incrementor),
        "togglebutton" => Some(crate::Role::Button),
        "tree" => Some(crate::Role::Outline),
        _ => None,
    }
}

/// Returns true when `role` is in [`INTERACTIVE_ROLES`].
pub fn is_interactive_role(role: &str) -> bool {
    crate::Role::from_token(role).is_interactive()
}

pub fn is_canonical_role(role: &str) -> bool {
    crate::Role::is_canonical(role)
}

/// Returns true for roles whose checked/unchecked state can be queried and set.
pub fn is_toggleable_role(role: &str) -> bool {
    matches!(
        crate::Role::from_token(role),
        crate::Role::Checkbox | crate::Role::Switch | crate::Role::RadioButton
    )
}

/// Returns true for roles that carry an expanded/collapsed surface state.
pub fn is_expandable_role(role: &str) -> bool {
    matches!(
        crate::Role::from_token(role),
        crate::Role::ComboBox
            | crate::Role::MenuButton
            | crate::Role::TreeItem
            | crate::Role::Disclosure
    )
}

/// Returns true for roles whose `value` changes during normal interaction and
/// must not be treated as stable ref identity.
pub fn is_mutable_value_role(role: &str) -> bool {
    matches!(
        crate::Role::from_token(role),
        crate::Role::ComboBox
            | crate::Role::Checkbox
            | crate::Role::Handle
            | crate::Role::Incrementor
            | crate::Role::ListBox
            | crate::Role::RadioButton
            | crate::Role::ScrollBar
            | crate::Role::Slider
            | crate::Role::Switch
            | crate::Role::TextField
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn is_interactive_role_matches_interactive_roles_list() {
        for role in INTERACTIVE_ROLES {
            assert!(is_interactive_role(role), "{role} should be interactive");
        }
    }

    #[test]
    fn interactive_roles_are_sorted_and_unique() {
        let mut sorted = INTERACTIVE_ROLES.to_vec();
        sorted.sort_unstable();
        sorted.dedup();
        assert_eq!(sorted.as_slice(), INTERACTIVE_ROLES);
    }

    #[test]
    fn normalize_role_query_folds_playwright_aliases() {
        for (alias, canonical) in [
            ("gridcell", "cell"),
            ("img", "image"),
            ("radio", "radiobutton"),
            ("searchbox", "textfield"),
            ("searchfield", "textfield"),
            ("spinbutton", "incrementor"),
            ("textarea", "textfield"),
            ("textbox", "textfield"),
            ("togglebutton", "button"),
            ("tree", "outline"),
        ] {
            assert_eq!(normalize_role_query(alias), canonical, "{alias}");
            assert!(is_valid_role_query(alias), "{alias}");
        }
    }

    #[test]
    fn normalize_role_query_is_case_insensitive_and_trimmed() {
        assert_eq!(normalize_role_query("Button"), "button");
        assert_eq!(normalize_role_query(" TEXTAREA "), "textfield");
    }

    #[test]
    fn normalize_role_query_fails_unknown_roles_closed() {
        assert_eq!(normalize_role_query("navbar"), "unknown");
        assert_eq!(normalize_role_query("buttn"), "unknown");
    }

    #[test]
    fn interactive_role_expandables_are_in_interactive_roles() {
        for role in ["combobox", "menubutton", "treeitem"] {
            assert!(
                is_expandable_role(role),
                "{role} expected expandable for subset check"
            );
            assert!(
                INTERACTIVE_ROLES.contains(&role),
                "expandable role {role} missing from INTERACTIVE_ROLES"
            );
        }
        assert!(is_expandable_role("disclosure"));
        assert!(!is_interactive_role("disclosure"));
        assert!(!is_expandable_role("button"));
        assert!(!is_expandable_role("checkbox"));
    }

    #[test]
    fn every_toggleable_role_is_interactive() {
        for role in ["checkbox", "switch", "radiobutton"] {
            assert!(is_toggleable_role(role));
            assert!(is_mutable_value_role(role));
            assert!(
                INTERACTIVE_ROLES.contains(&role),
                "toggleable role {role} missing from INTERACTIVE_ROLES"
            );
        }
        assert!(!is_toggleable_role("button"));
        assert!(!is_toggleable_role("textfield"));
    }

    #[test]
    fn read_only_roles_are_never_interactive() {
        for role in ["statictext", "image", "group", "list", "table"] {
            assert!(!is_interactive_role(role));
        }
    }

    #[test]
    fn mutable_value_roles_are_interactive() {
        for role in [
            "checkbox",
            "combobox",
            "incrementor",
            "listbox",
            "radiobutton",
            "slider",
            "switch",
            "textfield",
        ] {
            assert!(is_mutable_value_role(role));
            assert!(is_interactive_role(role));
        }
        assert!(!is_mutable_value_role("cell"));
        assert!(!is_mutable_value_role("button"));
    }
}
