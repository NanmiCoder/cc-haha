use crate::convert::string::try_c_to_string;
use crate::types::AdNotificationFilter;
use agent_desktop_core::NotificationFilter;
use agent_desktop_core::{AdapterError, ErrorCode};

/// Converts a C `AdNotificationFilter` into the core filter type.
///
/// - `null` pointer → `Ok(NotificationFilter::default())` (no filter).
/// - `has_limit == false` → the numeric limit is cleared regardless of
///   `limit` contents.
/// - Non-null `app` / `text` with invalid UTF-8 → `Err` rather than
///   silently dropping the filter (which would widen operations like
///   `ad_dismiss_all_notifications` to every app on the system).
///
/// # Safety
/// `filter` must be null or point to a valid `AdNotificationFilter`.
/// The embedded C strings must outlive this call.
pub(crate) unsafe fn filter_from_c(
    filter: *const AdNotificationFilter,
) -> Result<NotificationFilter, AdapterError> {
    if filter.is_null() {
        return Ok(NotificationFilter::default());
    }
    let f: &AdNotificationFilter = unsafe { &*filter };
    let app = unsafe { try_c_to_string(f.app) }
        .map_err(|err| AdapterError::new(ErrorCode::InvalidArgs, err.describe("filter.app")))?;
    let text = unsafe { try_c_to_string(f.text) }
        .map_err(|err| AdapterError::new(ErrorCode::InvalidArgs, err.describe("filter.text")))?;
    Ok(NotificationFilter {
        app,
        text,
        limit: if f.has_limit {
            Some(f.limit as usize)
        } else {
            None
        },
    })
}
