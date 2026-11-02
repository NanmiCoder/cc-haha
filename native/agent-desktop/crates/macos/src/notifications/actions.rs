use agent_desktop_core::{
    ActionResult, AdapterError, Deadline, ErrorCode, InteractionPolicy, NotificationFilter,
    NotificationIdentity, NotificationInfo, verify_notification_identity,
};

use super::nc_session::{NcSession, close_session};

#[cfg(test)]
#[path = "actions_tests.rs"]
mod tests;

pub fn dismiss_notification(
    index: usize,
    app_filter: Option<&str>,
    identity: Option<&NotificationIdentity>,
    policy: InteractionPolicy,
    deadline: Deadline,
) -> Result<NotificationInfo, AdapterError> {
    require_foreground_policy(policy)?;
    let session = NcSession::open(policy, deadline)?;
    let result = dismiss_impl(index, app_filter, identity, policy, session.pid(), deadline);
    close_session(session, result)
}

pub fn dismiss_all(
    app_filter: Option<&str>,
    policy: InteractionPolicy,
    deadline: Deadline,
) -> Result<(Vec<NotificationInfo>, Vec<String>), AdapterError> {
    require_foreground_policy(policy)?;
    let session = NcSession::open(policy, deadline)?;
    let result = dismiss_all_impl(app_filter, policy, session.pid(), deadline);
    close_session(session, result)
}

pub fn notification_action(
    index: usize,
    identity: Option<&NotificationIdentity>,
    action_name: &str,
    policy: InteractionPolicy,
    deadline: Deadline,
) -> Result<ActionResult, AdapterError> {
    require_foreground_policy(policy)?;
    let session = NcSession::open(policy, deadline)?;
    let result = action_impl(index, identity, action_name, session.pid(), deadline);
    close_session(session, result)
}

#[cfg(target_os = "macos")]
fn dismiss_impl(
    index: usize,
    app_filter: Option<&str>,
    identity: Option<&NotificationIdentity>,
    policy: InteractionPolicy,
    pid: i32,
    deadline: Deadline,
) -> Result<NotificationInfo, AdapterError> {
    let filter = build_filter(app_filter);
    let entries = super::list::list_entries(&filter, pid, deadline)?;

    let entry = entries
        .iter()
        .find(|e| e.info.index == index)
        .ok_or_else(|| AdapterError::notification_not_found(index))?;
    verify_notification_identity(index, identity, &entry.info)?;

    let info = entry.info.clone();
    let matching_before = super::dismiss_verify::matching_count(&entries, entry);
    dismiss_entry(entry, policy, &filter, matching_before, pid, deadline)?;
    Ok(info)
}

#[cfg(target_os = "macos")]
fn dismiss_all_impl(
    app_filter: Option<&str>,
    policy: InteractionPolicy,
    pid: i32,
    deadline: Deadline,
) -> Result<(Vec<NotificationInfo>, Vec<String>), AdapterError> {
    let filter = build_filter(app_filter);
    let entries = super::list::list_entries(&filter, pid, deadline)?;

    let mut dismissed = Vec::new();
    let mut failures = Vec::new();

    for original in entries.iter().rev() {
        let current_entries = super::list::list_entries(&filter, pid, deadline)?;
        let Some(current) = current_entries
            .iter()
            .find(|entry| super::dismiss_verify::matches(original, entry))
        else {
            failures.push(format!(
                "#{}: notification disappeared before dismissal was attempted",
                original.info.index
            ));
            continue;
        };
        let matching_before = super::dismiss_verify::matching_count(&current_entries, current);
        match dismiss_entry(current, policy, &filter, matching_before, pid, deadline) {
            Ok(()) => dismissed.push(original.info.clone()),
            Err(e) => failures.push(format!("#{}: {}", original.info.index, e)),
        }
    }

    Ok((dismissed, failures))
}

#[cfg(target_os = "macos")]
fn dismiss_entry(
    entry: &super::list::NotificationEntry,
    policy: InteractionPolicy,
    filter: &NotificationFilter,
    matching_before: usize,
    pid: i32,
    deadline: Deadline,
) -> Result<(), AdapterError> {
    for action in ["AXDismiss", "AXRemoveFromParent"] {
        let outcome =
            crate::actions::ax_helpers::try_ax_action_or_err(&entry.element, action, deadline);
        if strategy_verified(outcome, entry, filter, matching_before, pid, deadline)? {
            return Ok(());
        }
    }

    let children = strategy_read(
        crate::notifications::read::children(&entry.element, deadline),
        deadline,
    )?
    .unwrap_or_default();
    let pressed = try_dismiss_button(&children, deadline)?;
    if strategy_verified(Ok(pressed), entry, filter, matching_before, pid, deadline)? {
        return Ok(());
    }

    if !crate::system::permissions::report(deadline)?.accessibility_granted() {
        return Err(AdapterError::permission_denied());
    }

    if !policy.allow_cursor_move {
        return Err(AdapterError::policy_denied_for_policy(
            "Notification dismissal requires revealing its close control with the pointer",
            policy,
        ));
    }
    if let Err(error) = hover_over(&entry.element, deadline) {
        strategy_succeeded(Err(error), deadline)?;
        return Err(all_dismiss_strategies_failed());
    }
    std::thread::sleep(std::time::Duration::from_millis(300));

    let children = strategy_read(
        crate::notifications::read::children(&entry.element, deadline),
        deadline,
    )?
    .unwrap_or_default();
    let pressed = try_dismiss_button(&children, deadline)?;
    if strategy_verified(Ok(pressed), entry, filter, matching_before, pid, deadline)? {
        return Ok(());
    }

    Err(all_dismiss_strategies_failed())
}

#[cfg(target_os = "macos")]
fn try_dismiss_button(
    children: &[crate::tree::AXElement],
    deadline: Deadline,
) -> Result<bool, AdapterError> {
    for child in children {
        let role = strategy_read(
            crate::notifications::read::string(child, "AXRole", deadline),
            deadline,
        )?;
        let Some(role) = role else {
            continue;
        };
        if role.as_deref() != Some("AXButton") {
            continue;
        }
        let name = strategy_read(
            crate::notifications::read::title_or_description(child, deadline),
            deadline,
        )?
        .flatten()
        .unwrap_or_default()
        .to_lowercase();
        let is_dismiss =
            name.contains("close") || name.contains("clear") || name.contains("dismiss");
        if is_dismiss
            && strategy_succeeded(
                crate::actions::ax_helpers::try_ax_action_or_err(child, "AXPress", deadline),
                deadline,
            )?
        {
            return Ok(true);
        }
    }
    Ok(false)
}

/// Presses a named action button on the notification at `index`.
///
/// When `identity` is provided, rejects rows whose fingerprint no longer matches after NC reordering.
#[cfg(target_os = "macos")]
fn action_impl(
    index: usize,
    identity: Option<&NotificationIdentity>,
    action_name: &str,
    pid: i32,
    deadline: Deadline,
) -> Result<ActionResult, AdapterError> {
    let filter = NotificationFilter::default();
    let entries = super::list::list_entries(&filter, pid, deadline)?;

    let entry = entries
        .into_iter()
        .find(|e| e.info.index == index)
        .ok_or_else(|| AdapterError::notification_not_found(index))?;

    verify_notification_identity(index, identity, &entry.info)?;

    let children = crate::notifications::read::children(&entry.element, deadline)?;
    let action_lower = action_name.to_lowercase();
    let mut action_btn = None;
    for child in &children {
        let role = crate::notifications::read::string(child, "AXRole", deadline)?;
        let identifier = crate::notifications::read::string(child, "AXIdentifier", deadline)?;
        let name =
            crate::notifications::read::title_or_description(child, deadline)?.unwrap_or_default();
        if role.as_deref() == Some("AXButton")
            && crate::notifications::scan::is_notification_action(identifier.as_deref())
            && name.to_lowercase() == action_lower
        {
            action_btn = Some(child);
            break;
        }
    }
    let btn = action_btn.ok_or_else(|| {
        AdapterError::new(
            ErrorCode::ActionFailed,
            format!(
                "Action '{}' not found on notification {}",
                action_name, index
            ),
        )
    })?;

    if !crate::actions::ax_helpers::try_ax_action_or_err(btn, "AXPress", deadline)? {
        return Err(AdapterError::new(
            ErrorCode::ActionFailed,
            format!(
                "Failed to press '{}' button on notification {}",
                action_name, index
            ),
        ));
    }

    Ok(ActionResult::delivered_unverified(action_name))
}

#[cfg(target_os = "macos")]
fn hover_over(el: &crate::tree::AXElement, deadline: Deadline) -> Result<(), AdapterError> {
    use agent_desktop_core::{MouseButton, MouseEvent, MouseEventKind, Point};

    let bounds = crate::notifications::read::bounds(el, deadline)?
        .ok_or_else(|| AdapterError::internal("Cannot read notification bounds for hover"))?;

    crate::input::mouse::synthesize_mouse(
        MouseEvent {
            kind: MouseEventKind::Move,
            point: Point {
                x: bounds.x + bounds.width / 2.0,
                y: bounds.y + bounds.height / 2.0,
            },
            button: MouseButton::Left,
            modifiers: Vec::new(),
        },
        deadline,
    )
}

fn require_foreground_policy(policy: InteractionPolicy) -> Result<(), AdapterError> {
    if policy.allow_focus_steal {
        Ok(())
    } else {
        Err(AdapterError::policy_denied_for_policy(
            "Notification Center interaction requires foreground access",
            policy,
        ))
    }
}

fn build_filter(app_filter: Option<&str>) -> NotificationFilter {
    NotificationFilter {
        app: app_filter.map(String::from),
        ..Default::default()
    }
}

fn strategy_succeeded(
    outcome: Result<bool, AdapterError>,
    deadline: Deadline,
) -> Result<bool, AdapterError> {
    match outcome {
        Ok(succeeded) => Ok(succeeded),
        Err(error) => {
            crate::notifications::read::tolerate_ax_strategy_error(error, deadline)?;
            Ok(false)
        }
    }
}

fn strategy_read<T>(
    outcome: Result<T, AdapterError>,
    deadline: Deadline,
) -> Result<Option<T>, AdapterError> {
    match outcome {
        Ok(value) => Ok(Some(value)),
        Err(error) => {
            crate::notifications::read::tolerate_ax_strategy_error(error, deadline)?;
            Ok(None)
        }
    }
}

fn strategy_verified(
    outcome: Result<bool, AdapterError>,
    entry: &super::list::NotificationEntry,
    filter: &NotificationFilter,
    matching_before: usize,
    pid: i32,
    deadline: Deadline,
) -> Result<bool, AdapterError> {
    super::dismiss_verify::verified_after_strategy(outcome, deadline, || {
        match super::dismiss_verify::disappeared(entry, filter, matching_before, pid, deadline) {
            Ok(disappeared) => Ok(disappeared),
            Err(error) => {
                crate::notifications::read::tolerate_ax_strategy_error(error, deadline)?;
                Ok(false)
            }
        }
    })
}

fn all_dismiss_strategies_failed() -> AdapterError {
    AdapterError::new(
        ErrorCode::ActionFailed,
        "All dismiss strategies failed (AXDismiss, AXRemoveFromParent, close button, hover+close)",
    )
}

#[cfg(not(target_os = "macos"))]
fn dismiss_impl(
    _index: usize,
    _app_filter: Option<&str>,
    _identity: Option<&NotificationIdentity>,
    _policy: InteractionPolicy,
    _pid: i32,
    _deadline: Deadline,
) -> Result<NotificationInfo, AdapterError> {
    Err(AdapterError::not_supported("dismiss_notification"))
}

#[cfg(not(target_os = "macos"))]
fn dismiss_all_impl(
    _app_filter: Option<&str>,
    _policy: InteractionPolicy,
    _pid: i32,
    _deadline: Deadline,
) -> Result<(Vec<NotificationInfo>, Vec<String>), AdapterError> {
    Err(AdapterError::not_supported("dismiss_all_notifications"))
}

#[cfg(not(target_os = "macos"))]
fn action_impl(
    _index: usize,
    _identity: Option<&NotificationIdentity>,
    _action_name: &str,
    _pid: i32,
    _deadline: Deadline,
) -> Result<ActionResult, AdapterError> {
    Err(AdapterError::not_supported("notification_action"))
}
