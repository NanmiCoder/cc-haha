use crate::{
    AppError, ErrorCode,
    adapter::{PlatformAdapter, WindowFilter},
    commands::{
        helpers::resolve_app,
        wait_element::{ElementWaitInput, wait_for_element},
        wait_mode::WaitMode,
        wait_notification,
        wait_surface::SurfaceWait,
        wait_text_match, wait_timeout,
    },
    context::CommandContext,
    refs::refs_store::RefStore,
    snapshot::{self, emit_snapshot_saved},
    trace::trace_artifacts,
    tree::search_text,
};
use serde_json::{Value, json};
use std::time::{Duration, Instant};

#[cfg(test)]
use crate::commands::wait_mode::validate_wait_mode;

#[derive(Clone)]
pub struct WaitArgs {
    pub mode: WaitModeArgs,
    pub predicate: WaitPredicateArgs,
    pub timeout_ms: u64,
    pub app: Option<String>,
}

#[derive(Clone, Default)]
pub struct WaitModeArgs {
    pub ms: Option<u64>,
    pub element: Option<String>,
    pub window: Option<String>,
    pub text: Option<String>,
    pub surface: Option<SurfaceWait>,
    pub event: Option<String>,
    pub window_id: Option<String>,
}

#[derive(Clone)]
pub struct WaitPredicateArgs {
    pub predicate: Option<String>,
    pub value: Option<String>,
    pub action: Option<String>,
    pub count: Option<usize>,
}

pub fn execute(
    args: WaitArgs,
    adapter: &dyn PlatformAdapter,
    context: &CommandContext,
) -> Result<Value, AppError> {
    let timeout_ms = args.timeout_ms;
    match WaitMode::from_args(args)? {
        WaitMode::Sleep(ms) => {
            let deadline = crate::Deadline::after(ms)?;
            std::thread::sleep(deadline.remaining());
            if deadline.was_capped() {
                return Err(deadline.timeout_error().into());
            }
            Ok(json!({ "waited_ms": ms }))
        }
        WaitMode::Menu { app, open } => wait_for_menu(app, open, timeout_ms, adapter),
        WaitMode::Notification { app, text } => {
            wait_notification::wait_for_notification(app, text, timeout_ms, adapter, context)
        }
        WaitMode::Element { ref_id, predicate } => wait_for_element(
            ElementWaitInput {
                ref_id,
                predicate,
                timeout_ms,
            },
            adapter,
            context,
        ),
        WaitMode::Window { title, app } => wait_for_window(title, app, timeout_ms, adapter),
        WaitMode::Text { text, count, app } => wait_for_text(
            TextWaitInput {
                text,
                expected_count: count,
                app,
                timeout_ms,
            },
            adapter,
            context,
        ),
        WaitMode::Event {
            event,
            app,
            window_id,
            window_title,
        } => crate::commands::wait_event::wait_for_event(
            crate::commands::wait_event_input::EventWaitInput {
                event,
                app,
                window_id,
                window_title,
                timeout_ms,
            },
            adapter,
            context.event_baseline().cloned(),
        ),
    }
}

fn wait_for_menu(
    app: Option<String>,
    open: bool,
    timeout_ms: u64,
    adapter: &dyn PlatformAdapter,
) -> Result<Value, AppError> {
    let start = Instant::now();
    let deadline = crate::Deadline::at(start, timeout_ms)?;
    let target = resolve_app(app.as_deref(), adapter, deadline).map_err(|error| match error {
        AppError::Adapter(error) => wait_timeout::menu(error, timeout_ms),
        other => other,
    })?;
    let process = crate::commands::helpers::process_identity(&target)?;
    adapter
        .wait_for_menu(process.clone(), open, deadline)
        .map_err(|error| {
            wait_timeout::menu(
                crate::ref_action::ref_action_wait_support::with_exited_process_state(
                    adapter, process, error, deadline,
                ),
                timeout_ms,
            )
        })?;
    let elapsed = start.elapsed().as_millis();
    Ok(json!({ "found": true, "elapsed_ms": elapsed }))
}

fn wait_for_window(
    title: String,
    app: Option<String>,
    timeout_ms: u64,
    adapter: &dyn PlatformAdapter,
) -> Result<Value, AppError> {
    let start = Instant::now();
    let deadline = crate::Deadline::at(start, timeout_ms)?;
    let filter = WindowFilter {
        focused_only: false,
        app,
    };
    let mut last_error = None;
    let mut last_observed = None;

    loop {
        if deadline.is_expired() {
            return wait_timeout::window(
                &title,
                filter.app.as_deref(),
                timeout_ms,
                last_error,
                last_observed,
            );
        }
        match adapter.list_windows(&filter, deadline) {
            Ok(windows) => {
                if let Some(win) = windows.iter().find(|w| w.title.contains(&title)) {
                    let elapsed = start.elapsed().as_millis();
                    return Ok(json!({ "found": true, "window": win, "elapsed_ms": elapsed }));
                }
                last_observed = Some(wait_timeout::window_observation(&windows));
            }
            Err(err) if wait_timeout::is_deadline_expired(&err) => {
                return wait_timeout::window(
                    &title,
                    filter.app.as_deref(),
                    timeout_ms,
                    last_error,
                    last_observed,
                );
            }
            Err(err) if is_retryable_window_poll_error(&err) => {
                last_error = Some(json!({
                    "code": err.code.as_str(),
                    "message": err.message
                }));
            }
            Err(err) => return Err(AppError::Adapter(err)),
        }

        std::thread::sleep(deadline.remaining().min(Duration::from_millis(100)));
    }
}

struct TextWaitInput {
    text: String,
    expected_count: Option<usize>,
    app: Option<String>,
    timeout_ms: u64,
}

fn wait_for_text(
    input: TextWaitInput,
    adapter: &dyn PlatformAdapter,
    context: &CommandContext,
) -> Result<Value, AppError> {
    let TextWaitInput {
        text,
        expected_count,
        app,
        timeout_ms,
    } = input;
    let start = Instant::now();
    let deadline = crate::Deadline::at(start, timeout_ms)?;
    let opts = crate::adapter::TreeOptions::default();
    let normalized_text = search_text::normalize(&text);
    let mut scheduler = super::wait_scheduler::WaitScheduler::new(
        adapter,
        &crate::SignalFilter {
            app: app.clone(),
            process: None,
        },
        deadline,
    );
    let mut last_error = None;

    loop {
        match snapshot::build(adapter, &opts, app.as_deref(), None, deadline) {
            Ok(mut result) => {
                let matches = wait_text_match::find(&result.tree, &normalized_text, expected_count);
                let matched = match expected_count {
                    Some(expected) => result.complete && matches.len() == expected,
                    None => !matches.is_empty(),
                };
                if matched {
                    let store = RefStore::for_session(context.session_id())?;
                    let snapshot_id = store.save_new_snapshot(&result.refmap)?;
                    trace_artifacts::copy_refmap_if_full(
                        context,
                        &store,
                        &snapshot_id,
                        &result.refmap,
                    )?;
                    result.bind_snapshot_id(snapshot_id.clone());
                    emit_snapshot_saved(context, &result)?;
                    let elapsed = start.elapsed().as_millis();
                    let found = matches.first();
                    let mut body = json!({
                        "found": true,
                        "text": text,
                        "ref": found
                            .and_then(|found| found.ref_id.as_deref())
                            .map(|ref_id| crate::refs::ref_token::qualify_ref_id(&snapshot_id, ref_id)),
                        "role": found.map(|found| found.role.clone()),
                        "snapshot_id": snapshot_id,
                        "elapsed_ms": elapsed
                    });
                    if expected_count.is_some() {
                        body["count"] = json!(matches.len());
                    }
                    return Ok(body);
                }
            }
            Err(AppError::Adapter(err)) if wait_timeout::is_deadline_expired(&err) => {
                return wait_timeout::text(&text, timeout_ms, expected_count, last_error);
            }
            Err(err) if is_retryable_wait_app_error(&err) => {
                last_error = Some(json!({
                    "code": err.code(),
                    "message": err.to_string()
                }));
            }
            Err(AppError::Adapter(mut err)) if err.code == ErrorCode::AmbiguousTarget => {
                err.suggestion = Some(
                    "Use `wait --window <title> --app <app>` to wait for the target window, or run `list-windows` and inspect it with `snapshot --window-id <id>`.".into(),
                );
                return Err(err.into());
            }
            Err(err) => return Err(err),
        }

        if deadline.is_expired() {
            return wait_timeout::text(&text, timeout_ms, expected_count, last_error);
        }

        scheduler.wait(deadline);
    }
}

pub(crate) fn is_retryable_wait_poll_error(code: &ErrorCode) -> bool {
    matches!(code, ErrorCode::Timeout | ErrorCode::ElementNotFound)
}

/// A window wait polls a condition that is not yet true, and an application
/// that has not registered on the desktop yet is that condition: the window
/// cannot exist before the application does. Absence is retried until the
/// deadline unless the adapter explicitly marks the error non-retryable.
fn is_retryable_window_poll_error(error: &crate::AdapterError) -> bool {
    is_retryable_wait_poll_error(&error.code)
        || (matches!(
            error.code,
            ErrorCode::AppNotFound | ErrorCode::WindowNotFound
        ) && error.permits_retry_by_default())
}

fn is_retryable_wait_app_error(err: &AppError) -> bool {
    matches!(err, AppError::Adapter(err) if is_retryable_window_poll_error(err))
}

#[cfg(test)]
#[path = "wait_test_support.rs"]
mod test_support;

#[cfg(test)]
#[path = "wait_tests.rs"]
mod tests;

#[cfg(test)]
#[path = "wait_scenario_count_tests.rs"]
mod scenario_count_tests;
#[cfg(test)]
#[path = "wait_scenario_menu_tests.rs"]
mod scenario_menu_tests;
#[cfg(test)]
#[path = "wait_scenario_tests.rs"]
mod scenario_tests;

#[cfg(test)]
#[path = "wait_element_tests.rs"]
mod element_tests;

#[cfg(test)]
#[path = "wait_predicate_tests.rs"]
mod predicate_tests;

#[cfg(test)]
#[path = "wait_resolution_tests.rs"]
mod resolution_tests;

#[cfg(test)]
#[path = "wait_deadline_tests.rs"]
mod deadline_tests;

#[cfg(test)]
#[path = "wait_window_retry_tests.rs"]
mod window_retry_tests;
