use crate::{
    AdapterError, AppError, ErrorCode, EventKind, ProcessIdentity, SignalBaseline, SignalFilter,
    adapter::PlatformAdapter, commands::wait_event_input::EventWaitInput,
};
use serde_json::json;

fn is_appearance_class(kind: &EventKind) -> bool {
    matches!(
        kind,
        EventKind::AppLaunched | EventKind::WindowOpened | EventKind::SurfaceAppeared { .. }
    )
}

pub(crate) fn signal_filter(
    input: &EventWaitInput,
    requested: &EventKind,
    seeded_baseline: Option<&Result<SignalBaseline, AdapterError>>,
    adapter: &dyn PlatformAdapter,
    deadline: crate::Deadline,
) -> Result<SignalFilter, AppError> {
    let with_process = |process: Option<crate::ProcessIdentity>| SignalFilter {
        app: input.app.clone(),
        process,
    };
    let Some(app) = input.app.as_deref() else {
        let process = window_process(input.window_id.as_deref(), adapter, deadline)?;
        return Ok(with_process(process));
    };
    if matches!(requested, EventKind::AppLaunched) {
        return Ok(with_process(None));
    }
    let successful_seed = seeded_baseline.and_then(|baseline| baseline.as_ref().ok());
    let seeded_process = successful_seed
        .map(|baseline| process_from_baseline(baseline, app))
        .transpose()?
        .flatten();
    if let Some(process) = seeded_process {
        return Ok(with_process(Some(process)));
    }
    if successful_seed.is_some() && matches!(requested, EventKind::AppTerminated) {
        return Ok(with_process(None));
    }
    match crate::commands::helpers::resolve_app(Some(app), adapter, deadline) {
        Ok(resolved) => Ok(with_process(Some(
            crate::commands::helpers::process_identity(&resolved)?,
        ))),
        Err(AppError::Adapter(err))
            if err.code == ErrorCode::AppNotFound && is_appearance_class(requested) =>
        {
            Ok(with_process(None))
        }
        Err(err) => Err(err),
    }
}

/// The process that owns the window a wait names by id, so a stopped process
/// instance is answered `APP_UNRESPONSIVE` on the window-id route the same way
/// the `--app` route answers it. A window the list does not hold yet leaves
/// the wait unscoped: `--window-id` narrows a match and never requires one.
fn window_process(
    window_id: Option<&str>,
    adapter: &dyn PlatformAdapter,
    deadline: crate::Deadline,
) -> Result<Option<ProcessIdentity>, AppError> {
    let Some(window_id) = window_id else {
        return Ok(None);
    };
    let Ok(windows) = adapter.list_windows(&crate::adapter::WindowFilter::default(), deadline)
    else {
        return Ok(None);
    };
    Ok(windows
        .into_iter()
        .find(|window| window.id == window_id)
        .and_then(|window| {
            window
                .process_instance
                .map(|instance| ProcessIdentity::new(window.pid, instance))
        }))
}

pub(crate) fn process_from_baseline(
    baseline: &SignalBaseline,
    app: &str,
) -> Result<Option<crate::ProcessIdentity>, AppError> {
    let mut matches = baseline
        .apps
        .iter()
        .filter(|candidate| candidate.matches_identifier(app));
    let Some(first) = matches.next() else {
        return Ok(None);
    };
    if matches.next().is_some() {
        return Err(AdapterError::ambiguous_target(format!(
            "Multiple application instances matched '{app}' in the event baseline"
        ))
        .into());
    }
    crate::commands::helpers::process_identity(first).map(Some)
}

pub(crate) fn validate_signal_scope(
    filter: &SignalFilter,
    baseline: &SignalBaseline,
) -> Result<(), AppError> {
    let Some(expected) = filter.process.as_ref() else {
        return Ok(());
    };
    let observed = baseline
        .apps
        .iter()
        .map(|app| (app.pid, app.process_instance.as_deref()))
        .chain(
            baseline
                .windows
                .iter()
                .map(|window| (window.pid, window.process_instance.as_deref())),
        )
        .chain(
            baseline
                .surfaces
                .iter()
                .map(|surface| (surface.pid, Some(surface.process_instance.as_str()))),
        );
    if let Some((pid, instance)) = observed.into_iter().find(|(pid, instance)| {
        *pid == expected.pid && *instance != Some(expected.instance.as_str())
    }) {
        return Err(AdapterError::new(
            ErrorCode::StaleRef,
            "Target process identity changed during event observation",
        )
        .with_details(json!({
            "kind": "process_changed",
            "expected_pid": expected.pid,
            "observed_pid": pid,
            "observed_instance_matches": instance == Some(expected.instance.as_str()),
            "retryable": false,
        }))
        .with_disposition(crate::DeliverySemantics::not_delivered())
        .into());
    }
    Ok(())
}
