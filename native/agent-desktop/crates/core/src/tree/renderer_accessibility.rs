use crate::{
    AppError, PlatformAdapter,
    locator::live_locator::{ObservationRequest, ObservationRoot, ObservedTree},
};

/// A renderer that has not published its accessibility tree yet is discovered
/// by walking the tree and failing, so every retry here costs a full
/// observation. Polling that at a fixed short interval spends the whole budget
/// re-walking a tree that is not ready — on a large renderer it burns dozens of
/// complete walks and returns nothing. The wait backs off instead, so a
/// renderer that activates quickly is still caught quickly while one that never
/// activates is retried a handful of times rather than continuously.
const INITIAL_ACTIVATION_RETRY: std::time::Duration = std::time::Duration::from_millis(25);
const MAX_ACTIVATION_RETRY: std::time::Duration = std::time::Duration::from_millis(400);

pub(crate) fn observe_tree(
    adapter: &dyn PlatformAdapter,
    root: ObservationRoot<'_>,
    request: &ObservationRequest,
) -> Result<ObservedTree, AppError> {
    let mut request = *request;
    let mut activated = false;
    let mut retry_delay = INITIAL_ACTIVATION_RETRY;
    loop {
        match adapter.observe_tree(root, &request) {
            Ok(tree) => return Ok(tree),
            Err(error) if error.requires_renderer_accessibility_activation() => {
                if !activated {
                    request.deadline = activate(adapter, root, request.deadline)?;
                    activated = true;
                }
                let remaining = request.deadline.remaining();
                if remaining.is_zero() {
                    return Err(request.deadline.timeout_error().into());
                }
                std::thread::sleep(remaining.min(retry_delay));
                retry_delay = retry_delay.saturating_mul(2).min(MAX_ACTIVATION_RETRY);
            }
            Err(error) => return Err(AppError::Adapter(error)),
        }
    }
}

fn activate(
    adapter: &dyn PlatformAdapter,
    root: ObservationRoot<'_>,
    observing: crate::Deadline,
) -> Result<crate::Deadline, AppError> {
    let started = std::time::Instant::now();
    switch_on(adapter, root).map_err(|error| match error {
        AppError::Adapter(ref adapter_error) if adapter_error.code == crate::ErrorCode::Timeout => {
            observing.timeout_error().into()
        }
        other => other,
    })?;
    Ok(observing.extended_by(started.elapsed()))
}

fn switch_on(adapter: &dyn PlatformAdapter, root: ObservationRoot<'_>) -> Result<(), AppError> {
    let acquired = adapter.acquire_interaction_lease(crate::Deadline::standard()?)?;
    adapter.activate_renderer_accessibility(root_process(root)?, &acquired)?;
    Ok(())
}

fn root_process(root: ObservationRoot<'_>) -> Result<crate::ProcessIdentity, AppError> {
    match root {
        ObservationRoot::Window(window) => window
            .process_instance
            .as_deref()
            .map(|instance| crate::ProcessIdentity::new(window.pid, instance)),
        ObservationRoot::Element { entry, .. } => entry
            .process
            .process_instance
            .as_deref()
            .map(|instance| crate::ProcessIdentity::new(entry.process.pid, instance)),
    }
    .ok_or_else(|| {
        crate::AdapterError::stale_ref_because("renderer process instance is unavailable").into()
    })
}

#[cfg(test)]
#[path = "renderer_accessibility_tests.rs"]
mod tests;
