use crate::system::registry::listed_window::ListedWindow;

pub(super) fn same_geometry(
    frame: &crate::system::x11::FrameFacts,
    client: &crate::system::x11::X11Client,
) -> bool {
    let (Some(actual), Some(native)) = (frame.extents, client.bounds) else {
        return false;
    };
    let edges = client.extents.unwrap_or(crate::system::x11::FrameExtents {
        left: 0,
        right: 0,
        top: 0,
        bottom: 0,
    });
    let Ok(left) = i32::try_from(edges.left) else {
        return false;
    };
    let Ok(right) = i32::try_from(edges.right) else {
        return false;
    };
    let Ok(top) = i32::try_from(edges.top) else {
        return false;
    };
    let Ok(bottom) = i32::try_from(edges.bottom) else {
        return false;
    };
    let outer = crate::tree::Extents {
        x: native.x.saturating_sub(left),
        y: native.y.saturating_sub(top),
        width: native.width.saturating_add(left).saturating_add(right),
        height: native.height.saturating_add(top).saturating_add(bottom),
    };
    [native, outer].iter().any(|bounds| {
        let (l, t, r, b) = client.shadow;
        let content = crate::tree::Extents {
            x: bounds.x.saturating_add(l),
            y: bounds.y.saturating_add(t),
            width: bounds.width.saturating_sub(l).saturating_sub(r),
            height: bounds.height.saturating_sub(t).saturating_sub(b),
        };
        [*bounds, content].iter().any(|expected| {
            actual.width > 0
                && actual.height > 0
                && actual.width == expected.width
                && actual.height == expected.height
                && (!frame.global_position || (actual.x == expected.x && actual.y == expected.y))
        })
    })
}

const UNPROVEN_KIND: &str = "native_window_unproven";

pub(crate) fn unproven(pid: u32) -> agent_desktop_core::AdapterError {
    agent_desktop_core::AdapterError::new(
        agent_desktop_core::ErrorCode::ActionNotSupported,
        format!(
            "The native window type of accessibility frame owned by pid {pid} could not be proven"
        ),
    )
    .with_details(serde_json::json!({ "kind": UNPROVEN_KIND }))
    .with_disposition(agent_desktop_core::DeliverySemantics::not_delivered())
}

/// Whether the error is the refusal for a frame whose native window could not
/// be proven. A window that changes while the listing reads gives it for that
/// moment, so a caller that waits for a window reads again instead of ending
/// on it.
pub(crate) fn is_unproven(error: &agent_desktop_core::AdapterError) -> bool {
    error
        .details
        .as_ref()
        .and_then(|details| details.get("kind"))
        .and_then(serde_json::Value::as_str)
        == Some(UNPROVEN_KIND)
}

/// Classify a complete, uniform group without choosing a native window identity.
pub(super) fn classify(
    window: &ListedWindow,
    windows: &[ListedWindow],
    clients: &[crate::system::x11::X11Client],
    user_ids: &std::collections::HashSet<u32>,
    helper_ids: &std::collections::HashSet<u32>,
    complete_process: bool,
) -> Result<bool, agent_desktop_core::AdapterError> {
    let frame = &window.frame;
    let frames: Vec<_> = windows
        .iter()
        .filter(|other| !other.unshown)
        .map(|other| &other.frame)
        .collect();
    if !complete_process {
        return Err(unproven(frame.pid));
    }
    let owned: std::collections::HashSet<_> = clients
        .iter()
        .filter(|client| client.pid == Some(frame.pid))
        .map(|client| client.id)
        .collect();
    if owned.is_empty() {
        return Err(unproven(frame.pid));
    }
    if let Some(user) =
        super::embedded_group::classify(window, windows, clients, user_ids, helper_ids)
    {
        return Ok(user);
    }
    if owned.is_subset(user_ids) {
        return (owned.len() == frames.iter().filter(|other| other.pid == frame.pid).count())
            .then_some(true)
            .ok_or_else(|| unproven(frame.pid));
    }
    if owned
        .iter()
        .any(|id| !user_ids.contains(id) && !helper_ids.contains(id))
    {
        return Err(unproven(frame.pid));
    }
    let matching = |frame: &crate::system::x11::FrameFacts| -> std::collections::HashSet<u32> {
        clients
            .iter()
            .filter(|client| client.pid == Some(frame.pid) && same_geometry(frame, client))
            .map(|client| client.id)
            .collect()
    };
    let ids = matching(frame);
    if owned.intersection(user_ids).any(|id| {
        !frames
            .iter()
            .filter(|other| other.pid == frame.pid)
            .any(|other| matching(other).contains(id))
    }) {
        return Err(unproven(frame.pid));
    }
    let user = !ids.is_empty() && ids.is_subset(user_ids);
    if !user && (ids.is_empty() || !ids.is_subset(helper_ids)) {
        return Err(unproven(frame.pid));
    }
    let mut claims = 0;
    for other in frames.iter().filter(|other| other.pid == frame.pid) {
        let other_ids = matching(other);
        if !ids.is_disjoint(&other_ids) {
            if ids != other_ids {
                return Err(unproven(frame.pid));
            }
            claims += 1;
        }
    }
    (claims == ids.len())
        .then_some(user)
        .ok_or_else(|| unproven(frame.pid))
}
