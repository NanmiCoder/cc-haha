use agent_desktop_core::{AdapterError, Deadline, DeliverySemantics, ErrorCode, NotificationInfo};

use crate::system::shell::shell_surface::build_number;
use crate::system::shell::shell_surface_kinds::{EMPTY_CENTER_LANDMARKS, MAIN_LIST_VIEW};
use crate::tree::element::UIAElement;

const MAX_ENTRIES: usize = 256;
const MAX_WALK_DEPTH: u8 = 10;

const TITLE: &str = "Title";
const CONTENT: &str = "Content";
const ATTRIBUTION: &str = "Attribution";
const DISMISS_BUTTON: &str = "DismissButton";
const VERB_BUTTON: &str = "VerbButton";
const CLEAR_ALL_BUTTON: &str = "ClearAllButton";

#[cfg(test)]
#[path = "read_tests.rs"]
mod tests;

/// One read notification and the live element it was read from.
///
/// Mutating paths act on the same read that produced the identity they verified
/// against: the element is what the entry's own controls are located under at
/// invoke time, so a mutation never re-resolves its target by a second,
/// possibly reordered read.
pub(super) struct ListEntry {
    pub(super) info: NotificationInfo,
    pub(super) element: UIAElement,
}

/// What the open surface's landmark set says about its content. An open center
/// carries either the notification list (A26-3, notifications present) or the
/// empty-center landmarks in its place (A26-3, measured as the empty state's
/// shape on this build) - and carries neither only when the shell's tree does
/// not match the shape this adapter reads, which is a refusal, never an empty
/// answer.
#[derive(Debug)]
pub(super) enum CenterShape {
    WalkList,
    EmptyCenter,
}

pub(super) fn gate_landmarks(
    main_list_view_present: bool,
    empty_state_present: bool,
) -> Result<CenterShape, AdapterError> {
    if main_list_view_present {
        return Ok(CenterShape::WalkList);
    }
    if empty_state_present {
        return Ok(CenterShape::EmptyCenter);
    }
    Err(unrecognized_center_error())
}

pub(super) fn unrecognized_center_error() -> AdapterError {
    AdapterError::new(
        ErrorCode::PlatformNotSupported,
        "The open Action Center does not expose the notification list this adapter reads",
    )
    .with_platform_detail(format!(
        "Windows build {} exposes no '{MAIN_LIST_VIEW}' landmark under the open Action Center",
        build_number()
    ))
    .with_suggestion(
        "This host's shell presents a notification tree shape this adapter does not recognize; \
         capture a snapshot of the surface for diagnosis instead of retrying",
    )
    .with_disposition(DeliverySemantics::not_delivered())
}

pub(super) fn missing_clear_all_error() -> AdapterError {
    AdapterError::new(
        ErrorCode::PlatformNotSupported,
        "The open Action Center carries notifications but exposes no clear-all control",
    )
    .with_platform_detail(format!(
        "Windows build {} exposes no '{CLEAR_ALL_BUTTON}' landmark alongside a populated notification list",
        build_number()
    ))
    .with_disposition(DeliverySemantics::not_delivered())
}

/// Reads every notification entry the open center presents, in tree order,
/// with no index or filter applied yet.
#[cfg(target_os = "windows")]
pub(super) fn read_entries(
    root: &UIAElement,
    deadline: Deadline,
) -> Result<Vec<ListEntry>, AdapterError> {
    use uiautomation::types::TreeScope;

    let main_list_view = find_by_id(root, TreeScope::Descendants, MAIN_LIST_VIEW)?;
    let empty_state = empty_state_present(root)?;
    match gate_landmarks(main_list_view.is_some(), empty_state)? {
        CenterShape::EmptyCenter => Ok(Vec::new()),
        CenterShape::WalkList => {
            let list = main_list_view.ok_or_else(unrecognized_center_error)?;
            let mut entries = Vec::new();
            walk(&list, None, 0, &mut entries, deadline)?;
            Ok(entries)
        }
    }
}

#[cfg(not(target_os = "windows"))]
pub(super) fn read_entries(
    _root: &UIAElement,
    _deadline: Deadline,
) -> Result<Vec<ListEntry>, AdapterError> {
    Err(AdapterError::not_supported("read the Action Center"))
}

#[cfg(target_os = "windows")]
fn empty_state_present(root: &UIAElement) -> Result<bool, AdapterError> {
    use uiautomation::types::TreeScope;

    for landmark in EMPTY_CENTER_LANDMARKS {
        if find_by_id(root, TreeScope::Descendants, landmark)?.is_some() {
            return Ok(true);
        }
    }
    Ok(false)
}

/// The depth-first walk that attributes entries to their source application.
///
/// A `Group`/`HeaderItem` element carrying a direct `Title` child is a source
/// group's header (A26-3 measured the per-source header as a Group-typed
/// element under the list, not the ListViewHeaderItem control type its XAML
/// class would suggest), and its title names the application for every entry
/// met after it. Entries are `ListItem` elements; a list item without a
/// recognizable `Title` child is not a notification row this reader claims and
/// is skipped rather than counted, so indices stay positions among recognized
/// entries. Everything else is descended with the inherited group unchanged.
#[cfg(target_os = "windows")]
fn walk(
    element: &UIAElement,
    group: Option<&str>,
    depth: u8,
    entries: &mut Vec<ListEntry>,
    deadline: Deadline,
) -> Result<(), AdapterError> {
    use uiautomation::types::ControlType;

    if entries.len() >= MAX_ENTRIES {
        return Err(AdapterError::new(
            ErrorCode::AppUnresponsive,
            "Notification traversal reached its bounded entry limit",
        )
        .with_details(serde_json::json!({ "complete": false })));
    }
    if depth > MAX_WALK_DEPTH {
        return Err(AdapterError::new(
            ErrorCode::AppUnresponsive,
            "Notification traversal reached its bounded depth limit",
        )
        .with_details(serde_json::json!({ "complete": false })));
    }
    for child in children(element)? {
        deadline.ensure_remaining()?;
        match control_type(&child)? {
            ControlType::ListItem => {
                if let Some(entry) = entry_of(&child, group)? {
                    entries.push(entry);
                }
            }
            ControlType::Group | ControlType::HeaderItem => {
                let header = direct_child_title(&child)?;
                let inherited = header
                    .filter(|title| !title.is_empty())
                    .or(group.map(String::from));
                walk(&child, inherited.as_deref(), depth + 1, entries, deadline)?;
            }
            _ => {
                walk(&child, group, depth + 1, entries, deadline)?;
            }
        }
    }
    Ok(())
}

#[cfg(target_os = "windows")]
fn entry_of(item: &UIAElement, group: Option<&str>) -> Result<Option<ListEntry>, AdapterError> {
    use uiautomation::types::TreeScope;

    let title = match find_by_id(item, TreeScope::Descendants, TITLE)? {
        Some(element) => name_of(&element)?,
        None => return Ok(None),
    };
    if title.is_empty() {
        return Ok(None);
    }
    let body = match find_by_id(item, TreeScope::Descendants, CONTENT)? {
        Some(element) => {
            let content = name_of(&element)?;
            if content.is_empty() {
                None
            } else {
                Some(content)
            }
        }
        None => None,
    };
    let mut actions = Vec::new();
    for verb in find_all_by_id(item, TreeScope::Descendants, VERB_BUTTON)? {
        let name = name_of(&verb)?;
        if !name.is_empty() {
            actions.push(name);
        }
    }
    let app_name = match group {
        Some(name) => String::from(name),
        None => match find_by_id(item, TreeScope::Descendants, ATTRIBUTION)? {
            Some(element) => name_of(&element)?,
            None => String::new(),
        },
    };
    Ok(Some(ListEntry {
        info: NotificationInfo {
            index: 0,
            app_name,
            title,
            body,
            actions,
        },
        element: item.clone(),
    }))
}

#[cfg(target_os = "windows")]
fn children(element: &UIAElement) -> Result<Vec<UIAElement>, AdapterError> {
    use uiautomation::types::TreeScope;

    let client = crate::tree::automation::automation_client()?;
    let condition = client.create_true_condition().map_err(|error| {
        crate::tree::automation::uia_error(&error, "build the center's child condition")
    })?;
    let found = element
        .0
        .find_all(TreeScope::Children, &condition)
        .map_err(|error| {
            crate::tree::automation::uia_error(&error, "read the center's children")
        })?;
    Ok(found.into_iter().map(UIAElement::from).collect())
}

/// Locates one element by its `AutomationId`. Elements here are addressed by
/// `AutomationId`, never by localized name - this host's shell text is
/// localized (es-ES) while these ids are framework-stable (A26-3).
///
/// A probe whose search answers "no match" - exhaustion, or a subtree that
/// raced away between discovery and the read - reads as absence, the same
/// answer a genuinely empty region gives. Any other failure means the
/// search itself could not run, and surfaces as an error for the whole read:
/// reading a transient transport fault as absence would flow into the
/// landmark gate's "unrecognized tree" refusal and dress the fault up as a
/// shape this adapter does not recognize.
#[cfg(target_os = "windows")]
pub(super) fn find_by_id(
    element: &UIAElement,
    scope: uiautomation::types::TreeScope,
    automation_id: &str,
) -> Result<Option<UIAElement>, AdapterError> {
    use uiautomation::types::UIProperty;
    use uiautomation::variants::Variant;

    let client = crate::tree::automation::automation_client()?;
    let condition = client
        .create_property_condition(UIProperty::AutomationId, Variant::from(automation_id), None)
        .map_err(|error| {
            crate::tree::automation::uia_error(&error, "build an AutomationId condition")
        })?;
    classify_find(
        element.0.find_first(scope, &condition),
        "search for an element by AutomationId",
    )
}

/// The one decision every optional-result search in this module shares: a
/// found element is `Some`, an absence-family failure is `None`, and any
/// other failure surfaces through this file's error mapping.
#[cfg(target_os = "windows")]
fn classify_find(
    found: Result<uiautomation::UIElement, uiautomation::Error>,
    context: &'static str,
) -> Result<Option<UIAElement>, AdapterError> {
    match found {
        Ok(element) => Ok(Some(UIAElement::from(element))),
        Err(error) => {
            if crate::tree::automation::failure_of(&error).is_absence() {
                return Ok(None);
            }
            Err(crate::tree::automation::uia_error(&error, context))
        }
    }
}

/// [`classify_find`] for the multi-match search: an absence-family failure
/// is "no matches", anything else is an honest error.
#[cfg(target_os = "windows")]
fn classify_find_all(
    found: Result<Vec<uiautomation::UIElement>, uiautomation::Error>,
    context: &'static str,
) -> Result<Vec<UIAElement>, AdapterError> {
    match found {
        Ok(elements) => Ok(elements.into_iter().map(UIAElement::from).collect()),
        Err(error) => {
            if crate::tree::automation::failure_of(&error).is_absence() {
                return Ok(Vec::new());
            }
            Err(crate::tree::automation::uia_error(&error, context))
        }
    }
}

#[cfg(target_os = "windows")]
fn find_all_by_id(
    element: &UIAElement,
    scope: uiautomation::types::TreeScope,
    automation_id: &str,
) -> Result<Vec<UIAElement>, AdapterError> {
    use uiautomation::types::UIProperty;
    use uiautomation::variants::Variant;

    let client = crate::tree::automation::automation_client()?;
    let condition = client
        .create_property_condition(UIProperty::AutomationId, Variant::from(automation_id), None)
        .map_err(|error| {
            crate::tree::automation::uia_error(&error, "build an AutomationId condition")
        })?;
    classify_find_all(
        element.0.find_all(scope, &condition),
        "search for elements by AutomationId",
    )
}

#[cfg(target_os = "windows")]
fn direct_child_title(element: &UIAElement) -> Result<Option<String>, AdapterError> {
    use uiautomation::types::TreeScope;

    find_by_id(element, TreeScope::Children, TITLE)?
        .map(|title| name_of(&title))
        .transpose()
}

#[cfg(target_os = "windows")]
pub(super) fn find_dismiss_button(entry: &UIAElement) -> Result<Option<UIAElement>, AdapterError> {
    find_by_id(
        entry,
        uiautomation::types::TreeScope::Descendants,
        DISMISS_BUTTON,
    )
}

#[cfg(target_os = "windows")]
pub(super) fn find_verb_buttons(entry: &UIAElement) -> Result<Vec<UIAElement>, AdapterError> {
    find_all_by_id(
        entry,
        uiautomation::types::TreeScope::Descendants,
        VERB_BUTTON,
    )
}

#[cfg(target_os = "windows")]
pub(super) fn find_clear_all_button(root: &UIAElement) -> Result<Option<UIAElement>, AdapterError> {
    find_by_id(
        root,
        uiautomation::types::TreeScope::Descendants,
        CLEAR_ALL_BUTTON,
    )
}

/// Reads an element's `Name`.
///
/// This is a property read on an element the caller already holds, not a
/// search: unlike [`find_by_id`], there is no "absence" this call can report,
/// because a failure here always means the read itself could not complete,
/// most often because a virtualized list recycled the element between
/// discovery and this call. Swallowing it into an empty string would make a
/// real notification's title look blank rather than unreadable, so every
/// failure surfaces as an error instead.
#[cfg(target_os = "windows")]
pub(super) fn name_of(element: &UIAElement) -> Result<String, AdapterError> {
    element
        .0
        .get_name()
        .map_err(|error| crate::tree::automation::uia_error(&error, "read an element's name"))
}

/// [`name_of`]'s counterpart for `ControlType`: the same read-not-search
/// reasoning applies, so a failure surfaces rather than reading as "not a
/// recognized control".
#[cfg(target_os = "windows")]
fn control_type(element: &UIAElement) -> Result<uiautomation::types::ControlType, AdapterError> {
    element.0.get_control_type().map_err(|error| {
        crate::tree::automation::uia_error(&error, "read an element's control type")
    })
}
