use std::time::Instant;

use serde_json::{Value, json};

use crate::{
    AppError, NotificationFilter, NotificationInfo,
    adapter::PlatformAdapter,
    commands::{wait::is_retryable_wait_poll_error, wait_timeout},
    context::CommandContext,
};

pub(crate) fn wait_for_notification(
    app: Option<String>,
    text: Option<String>,
    timeout_ms: u64,
    adapter: &dyn PlatformAdapter,
    context: &CommandContext,
) -> Result<Value, AppError> {
    adapter.check_notification_support(crate::Deadline::standard()?)?;
    let filter = NotificationFilter {
        app: app.clone(),
        text: text.clone(),
        ..Default::default()
    };
    let start = Instant::now();
    let deadline = crate::Deadline::at(start, timeout_ms)?;
    let mut scheduler = super::wait_scheduler::WaitScheduler::new(
        adapter,
        &crate::SignalFilter {
            app: app.clone(),
            process: None,
        },
        deadline,
    );
    let mut baseline: Option<std::collections::HashMap<NotificationFingerprint, usize>> = None;
    let mut last_error = None;

    loop {
        if deadline.is_expired() {
            return wait_timeout::notification(app.as_ref(), text.as_ref(), timeout_ms, last_error);
        }
        match super::notification_policy::list_with_foreground_lease(
            &filter, deadline, adapter, context,
        ) {
            Ok(current) => match &baseline {
                None => {
                    baseline = Some(notification_counts(&current));
                }
                Some(baseline) => {
                    if let Some(notif) = first_new_notification(&current, baseline) {
                        let elapsed = start.elapsed().as_millis();
                        return Ok(json!({
                            "condition": "notification",
                            "matched": true,
                            "notification": notif,
                            "elapsed_ms": elapsed,
                        }));
                    }
                }
            },
            Err(AppError::Adapter(err)) if wait_timeout::is_deadline_expired(&err) => {
                return wait_timeout::notification(
                    app.as_ref(),
                    text.as_ref(),
                    timeout_ms,
                    last_error,
                );
            }
            Err(AppError::Adapter(err)) if is_retryable_wait_poll_error(&err.code) => {
                last_error = Some(json!({
                    "code": err.code.as_str(),
                    "message": err.message
                }));
            }
            Err(err) => return Err(err),
        }

        let remaining = deadline.remaining();
        if remaining.is_zero() {
            return wait_timeout::notification(app.as_ref(), text.as_ref(), timeout_ms, last_error);
        }
        scheduler.wait(deadline);
    }
}

#[derive(Clone, Eq, Hash, PartialEq)]
pub(crate) struct NotificationFingerprint {
    app_name: String,
    title: String,
    body: Option<String>,
    actions: Vec<String>,
}

impl From<&NotificationInfo> for NotificationFingerprint {
    fn from(info: &NotificationInfo) -> Self {
        Self {
            app_name: info.app_name.clone(),
            title: info.title.clone(),
            body: info.body.clone(),
            actions: info.actions.clone(),
        }
    }
}

pub(crate) fn notification_counts(
    notifications: &[NotificationInfo],
) -> std::collections::HashMap<NotificationFingerprint, usize> {
    let mut counts = std::collections::HashMap::new();
    for notification in notifications {
        *counts
            .entry(NotificationFingerprint::from(notification))
            .or_insert(0) += 1;
    }
    counts
}

pub(crate) fn first_new_notification<'a>(
    current: &'a [NotificationInfo],
    baseline: &std::collections::HashMap<NotificationFingerprint, usize>,
) -> Option<&'a NotificationInfo> {
    let mut seen = std::collections::HashMap::new();
    for notification in current {
        let fingerprint = NotificationFingerprint::from(notification);
        let current_count = seen.entry(fingerprint.clone()).or_insert(0);
        *current_count += 1;
        if *current_count > baseline.get(&fingerprint).copied().unwrap_or(0) {
            return Some(notification);
        }
    }
    None
}
