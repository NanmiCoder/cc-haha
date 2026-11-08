use super::capabilities::{copy_action_names_with_status, is_attr_settable_with_status};
use crate::tree::AXElement;
use agent_desktop_core::actions::capability;

#[cfg(target_os = "macos")]
use accessibility_sys::{kAXFocusedAttribute, kAXValueAttribute};

/// AppKit controls publish `AXPress`; document-shell rows publish `AXOpen` or
/// `AXConfirm` instead and never publish `AXPress`.
pub(crate) const PRIMARY_ACTIVATION_ACTIONS: [&str; 3] = ["AXPress", "AXOpen", "AXConfirm"];

pub(crate) struct AvailableActionsRead {
    pub(crate) actions: Vec<String>,
    pub(crate) complete: bool,
    pub(crate) cannot_complete: bool,
    pub(crate) invalid_element: bool,
    pub(crate) api_disabled: bool,
    pub(crate) deadline_exhausted: bool,
    pub(crate) settable_reads: u64,
}

impl Default for AvailableActionsRead {
    fn default() -> Self {
        Self {
            actions: Vec::new(),
            complete: true,
            cannot_complete: false,
            invalid_element: false,
            api_disabled: false,
            deadline_exhausted: false,
            settable_reads: 0,
        }
    }
}

#[cfg(target_os = "macos")]
pub(crate) fn read_platform_available_actions(
    el: &AXElement,
    role: &str,
    attrs: &crate::tree::NodeAttrs,
    deadline: std::time::Instant,
    usage: &mut crate::tree::observation_usage::ObservationUsage,
) -> AvailableActionsRead {
    let mut read = AvailableActionsRead::default();
    if crate::tree::locator_deadline::remaining(deadline).is_err() {
        read.complete = false;
        read.deadline_exhausted = true;
        return read;
    }
    let native_actions = copy_action_names_with_status(el, deadline, usage);
    if let Some(error) = native_actions.error {
        record_error(&mut read, error);
    }
    let ax_actions = native_actions.value.unwrap_or_default();
    let has = |name: &str| ax_actions.iter().any(|a| a == name);

    let publishes_activation = PRIMARY_ACTIVATION_ACTIONS.iter().any(|name| has(name));
    if publishes_activation {
        push_unique(&mut read.actions, capability::CLICK);
        if crate::tree::roles::is_toggleable_role(role) {
            push_unique(&mut read.actions, capability::TOGGLE);
        }
    } else if crate::actions::select::container_select::role_activates_by_selection(role)
        && read_settable(
            el,
            crate::actions::select::container_select::SELECTED,
            deadline,
            &mut read,
        )
        .unwrap_or(false)
    {
        push_unique(&mut read.actions, capability::CLICK);
    }
    if has("AXShowMenu") && role_allows_context_menu_action(role) {
        push_unique(&mut read.actions, capability::RIGHT_CLICK);
    }
    if has("AXScrollToVisible") {
        push_unique(&mut read.actions, capability::SCROLL_TO);
    }
    if has_scroll_mechanism(&has, attrs.has_scrollbars) {
        push_unique(&mut read.actions, capability::SCROLL);
    }
    let value_settable = value_settable(role, attrs.states.control.readonly, || {
        read_settable(el, kAXValueAttribute, deadline, &mut read)
    });
    if has("AXIncrement") || has("AXDecrement") || value_settable {
        push_unique(&mut read.actions, capability::SET_VALUE);
    }
    if (role == "combobox" && value_settable) || role_supports_collection_select(role) {
        push_unique(&mut read.actions, capability::SELECT);
    }
    if role_may_accept_focus(role)
        && read_settable(el, kAXFocusedAttribute, deadline, &mut read).unwrap_or(false)
    {
        push_unique(&mut read.actions, capability::SET_FOCUS);
    }
    if role_may_insert_text(role)
        && read_settable(el, "AXSelectedText", deadline, &mut read).unwrap_or(false)
    {
        push_unique(&mut read.actions, capability::TYPE_TEXT);
    }
    if (role_may_expand(role)
        && read_settable(el, "AXExpanded", deadline, &mut read).unwrap_or(false))
        || (has("AXPress") && agent_desktop_core::tree::roles::is_expandable_role(role))
    {
        push_unique(&mut read.actions, capability::EXPAND);
        push_unique(&mut read.actions, capability::COLLAPSE);
    }

    read
}

#[cfg(target_os = "macos")]
fn read_settable(
    element: &AXElement,
    attribute: &str,
    deadline: std::time::Instant,
    read: &mut AvailableActionsRead,
) -> Option<bool> {
    if crate::tree::locator_deadline::remaining(deadline).is_err() {
        read.complete = false;
        read.deadline_exhausted = true;
        return None;
    }
    read.settable_reads += 1;
    let result = is_attr_settable_with_status(element, attribute, deadline);
    if let Some(error) = result.error {
        record_error(read, error);
    }
    result.value
}

#[cfg(target_os = "macos")]
fn record_error(read: &mut AvailableActionsRead, error: i32) {
    if is_definitive_absence(error) {
        return;
    }
    read.complete = false;
    read.cannot_complete |= error == accessibility_sys::kAXErrorCannotComplete;
    read.invalid_element |= error == accessibility_sys::kAXErrorInvalidUIElement;
    read.api_disabled |= error == accessibility_sys::kAXErrorAPIDisabled;
}

#[cfg(target_os = "macos")]
fn is_definitive_absence(error: i32) -> bool {
    crate::tree::properties::ax_absence::is_absent_action_error(error)
}

fn role_may_bear_value(role: &str) -> bool {
    matches!(
        role,
        "textfield"
            | "combobox"
            | "slider"
            | "incrementor"
            | "stepper"
            | "spinbutton"
            | "checkbox"
            | "radiobutton"
            | "switch"
            | "colorwell"
            | "scrollbar"
            | "handle"
    )
}

fn value_settable(
    role: &str,
    readonly: Option<bool>,
    probe: impl FnOnce() -> Option<bool>,
) -> bool {
    role_may_bear_value(role)
        && readonly
            .map(|readonly| !readonly)
            .or_else(probe)
            .unwrap_or(false)
}

fn role_may_accept_focus(role: &str) -> bool {
    agent_desktop_core::tree::roles::is_interactive_role(role)
        || matches!(
            role,
            "table" | "outline" | "list" | "browser" | "webarea" | "scrollarea" | "group" | "row"
        )
}

fn role_may_expand(role: &str) -> bool {
    agent_desktop_core::tree::roles::is_expandable_role(role)
        || matches!(
            role,
            "group" | "outline" | "row" | "browser" | "table" | "list" | "cell"
        )
}

fn role_may_insert_text(role: &str) -> bool {
    matches!(role, "textfield" | "combobox")
}

#[cfg(not(target_os = "macos"))]
pub(crate) fn read_platform_available_actions(
    _el: &AXElement,
    _role: &str,
    _attrs: &crate::tree::NodeAttrs,
    _deadline: std::time::Instant,
    _usage: &mut crate::tree::observation_usage::ObservationUsage,
) -> AvailableActionsRead {
    AvailableActionsRead {
        complete: false,
        ..AvailableActionsRead::default()
    }
}

fn push_unique(actions: &mut Vec<String>, action: &str) {
    if !actions.iter().any(|a| a == action) {
        actions.push(action.to_string());
    }
}

fn role_allows_context_menu_action(role: &str) -> bool {
    !matches!(role, "combobox" | "menubutton")
}

fn role_supports_collection_select(role: &str) -> bool {
    matches!(role, "list" | "table" | "outline")
}

fn has_scroll_mechanism(has: &impl Fn(&str) -> bool, has_scrollbars: bool) -> bool {
    has("AXScrollDownByPage")
        || has("AXScrollUpByPage")
        || has("AXScrollLeftByPage")
        || has("AXScrollRightByPage")
        || has_scrollbars
}

#[cfg(test)]
mod tests {
    #[test]
    fn value_capability_reuses_observed_settability_and_probes_only_unknown_controls() {
        for (readonly, expected) in [(Some(true), false), (Some(false), true)] {
            assert_eq!(
                super::value_settable("textfield", readonly, || panic!("duplicate AX read")),
                expected
            );
        }
        let mut calls = 0;
        assert!(super::value_settable("textfield", None, || {
            calls += 1;
            Some(true)
        }));
        assert_eq!(calls, 1);
        assert!(!super::value_settable("group", None, || panic!(
            "inapplicable value read"
        )));
        assert!(!super::value_settable("textfield", None, || None));
    }

    #[cfg(target_os = "macos")]
    use super::{AvailableActionsRead, record_error};
    use super::{
        has_scroll_mechanism, role_allows_context_menu_action, role_may_accept_focus,
        role_may_bear_value, role_may_insert_text, role_supports_collection_select,
    };

    #[test]
    fn document_shell_activation_actions_are_recognised_alongside_press() {
        assert_eq!(
            super::PRIMARY_ACTIVATION_ACTIONS,
            ["AXPress", "AXOpen", "AXConfirm"]
        );
    }

    #[test]
    fn canonical_handle_role_is_probed_for_settable_value() {
        assert!(role_may_bear_value("handle"));
        assert!(!role_may_bear_value("valueindicator"));
    }

    #[test]
    fn focus_probe_is_limited_to_focus_bearing_roles() {
        assert!(role_may_accept_focus("textfield"));
        assert!(role_may_accept_focus("webarea"));
        assert!(!role_may_accept_focus("unknown"));
        assert!(!role_may_accept_focus("statictext"));
        assert!(!role_may_accept_focus("image"));
    }

    #[test]
    fn menu_opening_controls_do_not_advertise_right_click() {
        assert!(!role_allows_context_menu_action("combobox"));
        assert!(!role_allows_context_menu_action("menubutton"));
        assert!(role_allows_context_menu_action("textfield"));
        assert!(role_allows_context_menu_action("button"));
    }

    #[test]
    fn collection_containers_advertise_the_restored_select_contract() {
        assert!(role_supports_collection_select("list"));
        assert!(role_supports_collection_select("table"));
        assert!(role_supports_collection_select("outline"));
        assert!(!role_supports_collection_select("group"));
    }

    #[test]
    fn scroll_requires_native_directional_actions_or_concrete_scrollbars() {
        assert!(has_scroll_mechanism(
            &|name| name == "AXScrollDownByPage",
            false
        ));
        assert!(has_scroll_mechanism(&|_| false, true));
        assert!(!has_scroll_mechanism(&|_| false, false));
    }

    #[test]
    fn text_insertion_probe_is_limited_to_editable_text_roles() {
        assert!(role_may_insert_text("textfield"));
        assert!(role_may_insert_text("combobox"));
        assert!(!role_may_insert_text("unknown"));
        assert!(!role_may_insert_text("button"));
    }

    #[test]
    #[cfg(target_os = "macos")]
    fn failed_native_action_reads_remain_incomplete() {
        let mut read = AvailableActionsRead::default();

        record_error(&mut read, accessibility_sys::kAXErrorCannotComplete);

        assert!(!read.complete);
        assert!(read.cannot_complete);
        assert!(read.actions.is_empty());
    }

    #[test]
    #[cfg(target_os = "macos")]
    fn definitive_absence_codes_are_complete_empty_answers() {
        for error in [
            accessibility_sys::kAXErrorAttributeUnsupported,
            accessibility_sys::kAXErrorNoValue,
            accessibility_sys::kAXErrorNotImplemented,
            accessibility_sys::kAXErrorActionUnsupported,
            accessibility_sys::kAXErrorFailure,
        ] {
            let mut read = AvailableActionsRead::default();
            record_error(&mut read, error);
            assert!(read.complete, "code {error} must stay complete");
            assert!(!read.cannot_complete);
            assert!(read.actions.is_empty());
        }
    }

    #[test]
    #[cfg(target_os = "macos")]
    fn transport_failures_are_never_classified_as_absence() {
        for error in [
            accessibility_sys::kAXErrorCannotComplete,
            accessibility_sys::kAXErrorInvalidUIElement,
            accessibility_sys::kAXErrorAPIDisabled,
        ] {
            let mut read = AvailableActionsRead::default();
            record_error(&mut read, error);
            assert!(!read.complete, "code {error} must mark the read incomplete");
        }
    }
}
