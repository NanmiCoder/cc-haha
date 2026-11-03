use agent_desktop_core::{
    ActionResult, AdapterError, Deadline, DeliverySemantics, ErrorCode, InteractionPolicy,
    NotificationFilter, NotificationIdentity, NotificationInfo, verify_notification_identity,
};

use crate::tree::element::UIAElement;

use super::list::list_entries;
use super::read::ListEntry;
use super::session::{ActionCenterSession, close_session};
use super::verify::{
    action_changed_state, dismiss_survived_error, entry_gone, read_settling_without, same_identity,
    survivor_failures,
};

#[cfg(test)]
#[path = "actions_tests.rs"]
mod tests;

/// Removes exactly the identified notification and proves the removal by
/// re-reading the surface.
///
/// The foreground floor fires before the center is raised, the entry at the
/// requested index is located by a fresh read, the caller's identity is
/// verified against what that read found - the index is a position, never the
/// identity - and only then is the entry's own dismiss control invoked. An
/// invoke the shell accepts without acting on is reported `ACTION_FAILED`,
/// never success.
pub fn dismiss_notification(
    index: usize,
    app_filter: Option<&str>,
    identity: Option<&NotificationIdentity>,
    policy: InteractionPolicy,
    deadline: Deadline,
) -> Result<NotificationInfo, AdapterError> {
    require_foreground_policy(policy)?;
    let session = ActionCenterSession::open(policy, deadline)?;
    let result = dismiss_impl(index, app_filter, identity, session.hwnd(), deadline);
    close_session(session, result)
}

/// Clears the center and reports the outcome against the identity set captured
/// before the clear.
///
/// Only members of the captured set still present after the clear are
/// failures; entries outside it arrived during the clear and are new arrivals.
/// A partial clear is therefore a success shape carrying per-entry failures,
/// not a refusal - the envelope distinguishes them the way the command's
/// `dismissed_count` and `failures` fields do.
pub fn dismiss_all(
    app_filter: Option<&str>,
    policy: InteractionPolicy,
    deadline: Deadline,
) -> Result<(Vec<NotificationInfo>, Vec<String>), AdapterError> {
    require_foreground_policy(policy)?;
    let session = ActionCenterSession::open(policy, deadline)?;
    let result = dismiss_all_impl(app_filter, session.hwnd(), deadline);
    close_session(session, result)
}

/// Invokes the named action button on the identified notification.
///
/// The name must match one of the entry's action buttons exactly,
/// case-insensitively, the way the macOS adapter matches action names; a
/// notification offering no such button is refused with `ACTION_NOT_SUPPORTED`
/// and is left unchanged, because nothing was invoked.
pub fn notification_action(
    index: usize,
    identity: Option<&NotificationIdentity>,
    action_name: &str,
    policy: InteractionPolicy,
    deadline: Deadline,
) -> Result<ActionResult, AdapterError> {
    require_foreground_policy(policy)?;
    let session = ActionCenterSession::open(policy, deadline)?;
    let result = action_impl(index, identity, action_name, session.hwnd(), deadline);
    close_session(session, result)
}

/// Removes the entry at `index` with its own dismiss control, then verifies.
///
/// Measured on this build (A26-3's own cleanup protocol beside this module's
/// live runs): the shell can accept the entry's dismiss invoke without acting
/// on it, while the top-level clear-all control does act. The clear-all is
/// only a faithful substitute for the entry's own button when the target is
/// the center's sole entry - with any other entry present it would remove
/// notifications nobody asked to remove, so an accepted-and-ignored invoke
/// stays an honest `ACTION_FAILED` there.
fn dismiss_impl(
    index: usize,
    app_filter: Option<&str>,
    identity: Option<&NotificationIdentity>,
    hwnd: isize,
    deadline: Deadline,
) -> Result<NotificationInfo, AdapterError> {
    let filter = build_filter(app_filter);
    let entry = locate_and_verify(index, identity, &filter, hwnd, deadline)?;
    let info = entry.info.clone();

    invoke_dismiss(&entry.element, index)?;
    let mut current = read_settling_without(
        std::slice::from_ref(&info),
        hwnd,
        &NotificationFilter::default(),
        deadline,
    )?;
    if !entry_gone(&info, &current)
        && current.len() == 1
        && clear_all_still_the_sole_target(hwnd, &info, deadline)?
    {
        let root = crate::tree::automation::root_from_hwnd(hwnd, deadline)?;
        if let Some(clear) = super::read::find_clear_all_button(&root)? {
            invoke_element(&clear)?;
            current = read_settling_without(
                std::slice::from_ref(&info),
                hwnd,
                &NotificationFilter::default(),
                deadline,
            )?;
        }
    }

    if !entry_gone(&info, &current) {
        return Err(dismiss_survived_error(index));
    }
    Ok(info)
}

/// The clear-all substitute re-verifies, immediately before it fires, that
/// the center still holds exactly one entry and that it is still the target.
///
/// An entry arriving between the settle read and the invoke would be cleared
/// too if the substitute fired on the stale read, and the substitute exists
/// only as a faithful stand-in for the target's own dismiss control - never
/// as a way to clear more than the one identified notification. A re-read
/// that answers anything other than exactly-one-matching aborts the
/// substitute; the caller's survival check then reports the honest
/// `ACTION_FAILED`. A re-read that cannot run surfaces as an error, for the
/// same reason.
#[cfg(target_os = "windows")]
fn clear_all_still_the_sole_target(
    hwnd: isize,
    target: &NotificationInfo,
    deadline: Deadline,
) -> Result<bool, AdapterError> {
    let current = super::list::list_infos(&NotificationFilter::default(), hwnd, deadline)?;
    Ok(is_sole_target(target, &current))
}

fn is_sole_target(target: &NotificationInfo, current: &[NotificationInfo]) -> bool {
    matches!(current, [only] if same_identity(target, only))
}

fn dismiss_all_impl(
    app_filter: Option<&str>,
    hwnd: isize,
    deadline: Deadline,
) -> Result<(Vec<NotificationInfo>, Vec<String>), AdapterError> {
    let filter = build_filter(app_filter);
    let entries = list_entries(&filter, hwnd, deadline)?;
    if entries.is_empty() {
        return Ok((Vec::new(), Vec::new()));
    }
    let captured: Vec<NotificationInfo> = entries.into_iter().map(|entry| entry.info).collect();
    let mut invoke_errors: Vec<(usize, String)> = Vec::new();
    if app_filter.is_some() {
        dismiss_each_by_freshly_read_identity(
            &captured,
            &filter,
            hwnd,
            deadline,
            &mut invoke_errors,
        )?;
    } else {
        let root = crate::tree::automation::root_from_hwnd(hwnd, deadline)?;
        let clear = super::read::find_clear_all_button(&root)?
            .ok_or_else(super::read::missing_clear_all_error)?;
        invoke_element(&clear)?;
    }
    let current = read_settling_without(&captured, hwnd, &filter, deadline)?;
    let failures = dismiss_all_failures(&captured, &current, &invoke_errors);
    let dismissed = captured
        .iter()
        .filter(|member| entry_gone(member, &current))
        .cloned()
        .collect();
    Ok((dismissed, failures))
}

/// Dismisses each captured target through a freshly re-read live element,
/// never through the handle or index the outer capture took.
///
/// A filtered dismissal only ever narrows which entries are targeted; it must
/// never fall back to the Action-Center-wide clear-all, because that control
/// has no notion of "this app's entries" and would destroy every other
/// application's notifications along with the ones the caller asked to
/// remove. Removing one entry can renumber and recycle the elements after it
/// in the center's virtualized list, so every iteration re-reads the live
/// surface with the same filter and matches its target by identity - never by
/// the index or element handle the outer capture took, which may already be
/// stale by the time this entry's turn comes. An invoke's own error is
/// recorded against the target's captured index rather than discarded, so the
/// caller's survivor comparison can report the real reason a filtered entry
/// refused to leave, not just that it remained.
fn dismiss_each_by_freshly_read_identity(
    captured: &[NotificationInfo],
    filter: &NotificationFilter,
    hwnd: isize,
    deadline: Deadline,
    invoke_errors: &mut Vec<(usize, String)>,
) -> Result<(), AdapterError> {
    for target in captured {
        let live = list_entries(filter, hwnd, deadline)?;
        let Some(current) = live.iter().find(|entry| same_identity(target, &entry.info)) else {
            continue;
        };
        if let Err(error) = invoke_dismiss(&current.element, current.info.index) {
            invoke_errors.push((target.index, error.to_string()));
        }
    }
    Ok(())
}

/// One failure line per captured member still present after the clear,
/// carrying the specific invoke error a filtered dismissal recorded for it
/// when one exists, the generic survivor message otherwise - never both, and
/// never for a member the settle read proved gone. A member that vanished
/// during the clear is reported as dismissed even if its own invoke errored,
/// because the settle read is the proof the caller's envelope trusts, not the
/// invoke's own return value.
fn dismiss_all_failures(
    captured: &[NotificationInfo],
    current: &[NotificationInfo],
    invoke_errors: &[(usize, String)],
) -> Vec<String> {
    if invoke_errors.is_empty() {
        return survivor_failures(captured, current);
    }
    captured
        .iter()
        .filter(|member| !entry_gone(member, current))
        .map(|member| {
            match invoke_errors
                .iter()
                .find(|(index, _)| *index == member.index)
            {
                Some((_, message)) => format!("#{}: {}", member.index, message),
                None => format!(
                    "#{}: notification from the captured set is still present",
                    member.index
                ),
            }
        })
        .collect()
}

fn action_impl(
    index: usize,
    identity: Option<&NotificationIdentity>,
    action_name: &str,
    hwnd: isize,
    deadline: Deadline,
) -> Result<ActionResult, AdapterError> {
    let filter = NotificationFilter::default();
    let entry = locate_and_verify(index, identity, &filter, hwnd, deadline)?;
    let original = entry.info.clone();
    invoke_notification_action(&entry.element, action_name, index)?;
    let current = read_settling_without(std::slice::from_ref(&original), hwnd, &filter, deadline)?;
    let mut result = ActionResult::delivered_unverified(action_name);
    if action_changed_state(&original, &current) {
        result = result.with_verified_delivery();
    }
    Ok(result)
}

fn invoke_dismiss(entry: &UIAElement, index: usize) -> Result<(), AdapterError> {
    let button =
        super::read::find_dismiss_button(entry)?.ok_or_else(|| missing_dismiss_error(index))?;
    invoke_element(&button)
}

fn invoke_notification_action(
    entry: &UIAElement,
    action_name: &str,
    index: usize,
) -> Result<(), AdapterError> {
    let wanted = action_name.to_lowercase();
    for verb in super::read::find_verb_buttons(entry)? {
        if super::read::name_of(&verb)?.to_lowercase() == wanted {
            return invoke_element(&verb);
        }
    }
    Err(unknown_action_error(action_name, index))
}

#[cfg(target_os = "windows")]
fn invoke_element(element: &UIAElement) -> Result<(), AdapterError> {
    use uiautomation::patterns::UIInvokePattern;

    let pattern: UIInvokePattern = element
        .0
        .get_pattern()
        .map_err(|error| crate::tree::automation::uia_error(&error, "read the Invoke pattern"))?;
    pattern.invoke().map_err(|error| {
        crate::tree::automation::uia_error(&error, "invoke a notification control")
    })
}

#[cfg(not(target_os = "windows"))]
fn invoke_element(_element: &UIAElement) -> Result<(), AdapterError> {
    Err(AdapterError::not_supported("invoke a notification control"))
}

/// The floor every chrome-raising notification command answers to, checked
/// before the session raises anything - a policy that forbids the foreground
/// to move is refused while the desktop is still untouched.
pub(crate) fn require_foreground_policy(policy: InteractionPolicy) -> Result<(), AdapterError> {
    if policy.allow_focus_steal {
        return Ok(());
    }
    Err(AdapterError::policy_denied_for_policy(
        "Action Center interaction requires foreground access",
        policy,
    ))
}

/// The index is not trusted as identity: a caller-supplied expected app or
/// title is compared against what the re-read actually found at that index,
/// and a mismatch is `NOTIFICATION_NOT_FOUND` - the surface reordered under
/// the caller, so acting anyway would dismiss the wrong notification.
/// The listing entry a mutation targets, already checked against the
/// identity the caller expects it to still carry - the prelude every
/// mutation runs before it touches anything.
fn locate_and_verify(
    index: usize,
    identity: Option<&NotificationIdentity>,
    filter: &NotificationFilter,
    hwnd: isize,
    deadline: Deadline,
) -> Result<ListEntry, AdapterError> {
    let entries = list_entries(filter, hwnd, deadline)?;
    let entry = entries
        .into_iter()
        .find(|entry| entry.info.index == index)
        .ok_or_else(|| AdapterError::notification_not_found(index))?;
    verify_notification_identity(index, identity, &entry.info)?;
    Ok(entry)
}

fn build_filter(app_filter: Option<&str>) -> NotificationFilter {
    NotificationFilter {
        app: app_filter.map(String::from),
        ..Default::default()
    }
}

fn missing_dismiss_error(index: usize) -> AdapterError {
    AdapterError::new(
        ErrorCode::ActionFailed,
        format!("The notification at index {index} exposes no 'DismissButton' control to invoke"),
    )
    .with_suggestion("Re-run list-notifications and retry with a freshly observed entry")
    .with_disposition(DeliverySemantics::not_delivered())
}

fn unknown_action_error(action_name: &str, index: usize) -> AdapterError {
    AdapterError::new(
        ErrorCode::ActionNotSupported,
        format!("Action '{action_name}' is not offered by the notification at index {index}"),
    )
    .with_suggestion("Run list-notifications and use one of the entry's reported actions")
    .with_disposition(DeliverySemantics::not_delivered())
}
