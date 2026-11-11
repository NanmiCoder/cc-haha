use std::time::Duration;

use crate::{AdapterError, AppError, ErrorCode, PlatformAdapter, WindowFilter, WindowInfo};

const FOCUS_SETTLE_TIMEOUT_MS: u64 = 750;
const FOCUS_POLL_INTERVAL_MS: u64 = 50;
const FOCUS_CONFIRMATIONS: u8 = 2;

pub(crate) fn focus_and_confirm(
    adapter: &dyn PlatformAdapter,
    window: &WindowInfo,
    lease: &crate::InteractionLease,
) -> Result<WindowInfo, AppError> {
    adapter.focus_window(window, lease)?;
    wait_for_focused_window_with_poll_interval(
        adapter,
        &window.id,
        Some(&window.app),
        Duration::from_millis(FOCUS_POLL_INTERVAL_MS),
        lease.deadline(),
    )
}

pub(crate) fn wait_for_focused_window_with_poll_interval(
    adapter: &dyn PlatformAdapter,
    window_id: &str,
    app: Option<&str>,
    poll_interval: Duration,
    parent_deadline: crate::Deadline,
) -> Result<WindowInfo, AppError> {
    let deadline = parent_deadline.capped(Duration::from_millis(FOCUS_SETTLE_TIMEOUT_MS));
    let mut confirmations = 0;
    loop {
        match observed_focused_window(adapter, app, deadline) {
            Ok(Some(window)) if window.id == window_id => {
                confirmations += 1;
                if confirmations >= FOCUS_CONFIRMATIONS {
                    return Ok(window);
                }
            }
            Ok(_) => confirmations = 0,
            Err(AppError::Adapter(error)) if error.permits_retry_by_default() => {
                confirmations = 0;
            }
            Err(error) => return Err(error),
        }
        if deadline.is_expired() {
            return Err(AdapterError::new(
                ErrorCode::ActionFailed,
                "Window focus did not settle on the requested window",
            )
            .with_suggestion("Run 'list-windows' to refresh window IDs, then retry.")
            .into());
        }
        if !poll_interval.is_zero() {
            std::thread::sleep(poll_interval.min(deadline.remaining()));
        }
    }
}

fn observed_focused_window(
    adapter: &dyn PlatformAdapter,
    app: Option<&str>,
    deadline: crate::Deadline,
) -> Result<Option<WindowInfo>, AppError> {
    match adapter.focused_window(deadline) {
        Ok(window) => Ok(window),
        Err(err) if err.code == ErrorCode::PlatformNotSupported => adapter
            .list_windows(
                &WindowFilter {
                    focused_only: true,
                    app: app.map(str::to_string),
                },
                deadline,
            )
            .map(|windows| windows.into_iter().next())
            .map_err(AppError::Adapter),
        Err(err) => Err(AppError::Adapter(err)),
    }
}
