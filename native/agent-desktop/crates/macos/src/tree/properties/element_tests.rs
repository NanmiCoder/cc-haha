const ELEMENT_SOURCE: &str = include_str!("element.rs");
const NODE_ATTRIBUTE_FETCH_SOURCE: &str = include_str!("node_attribute_fetch.rs");
const ATTRIBUTE_NAMES_SOURCE: &str = include_str!("node_attribute_names.rs");
const READONLY_SOURCE: &str = include_str!("readonly.rs");

#[test]
fn generic_child_sources_prefer_exhaustive_navigation_order_before_content_subset() {
    assert_eq!(
        super::child_attributes(None),
        ["AXChildren", "AXChildrenInNavigationOrder", "AXContents"]
    );
    assert_eq!(
        super::child_attributes(Some("AXBrowser")),
        ["AXColumns", "AXContents"]
    );
    assert_eq!(
        super::child_attributes(Some("AXApplication")),
        ["AXWindows", "AXChildren"]
    );
}

#[test]
fn readonly_derivation_has_a_single_owner() {
    let editable_role_check_sites = READONLY_SOURCE.matches("editable_ax_role(role)").count();
    assert_eq!(
        editable_role_check_sites, 1,
        "readonly derivation must be computed once in compute_readonly, not re-derived \
         separately by fetch_node_attrs and fetch_node_attrs_slow"
    );
}

#[test]
fn fetch_node_attrs_reuses_cached_attr_names_array() {
    assert!(
        ATTRIBUTE_NAMES_SOURCE.contains("ATTRIBUTE_NAMES.with"),
        "fetch_node_attrs must reuse the thread-local cached attribute-name CFArray instead of \
         rebuilding its 22 CFStrings on every call"
    );
    assert!(
        !ELEMENT_SOURCE.contains(".map(|attribute| CFString::new(attribute))")
            && !NODE_ATTRIBUTE_FETCH_SOURCE.contains(".map(|attribute| CFString::new(attribute))"),
        "fetch_node_attrs regressed to rebuilding the CFString attr-name array inline per call; \
         that construction belongs solely in AttributeNames::new"
    );
}
