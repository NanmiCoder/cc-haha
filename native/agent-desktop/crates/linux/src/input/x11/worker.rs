use std::sync::mpsc::{Receiver, Sender};
use std::thread;
use std::time::Duration;

use agent_desktop_core::{AdapterError, Deadline, ErrorCode};
use serde_json::json;

use super::held_journal::HeldJournal;
use super::progress::Progress;
use super::sink::X11Sink;
use super::sink_error::SinkError;
use super::verify;
use crate::input::delivery::Delivery;
use crate::input::plan::Plan;
use crate::input::release_guard::ReleaseGuard;
use crate::input::release_state::ReleaseState;
use crate::input::step::Step;

const PAUSE_SLICE: Duration = Duration::from_millis(10);
pub(super) const ABORT_SUGGESTION: &str = "Run 'snapshot' to read the real state before retrying: some input may already have been delivered";

pub(crate) enum Report {
    Gate,
    Done(Result<Delivery, AdapterError>),
}

pub(crate) struct Link {
    pub(crate) reports: Sender<Report>,
    pub(crate) proceed: Receiver<bool>,
    pub(crate) journal: Option<HeldJournal>,
}

pub(crate) fn mark_started(error: AdapterError, started: bool) -> AdapterError {
    let mut details = error.details.clone().unwrap_or_else(|| json!({}));
    if let Some(map) = details.as_object_mut() {
        map.insert("physical_delivery_started".into(), started.into());
    }
    error.with_details(details)
}

pub(crate) fn work(
    mut sink: impl X11Sink,
    plans: Vec<Plan>,
    link: &Link,
    deadline: Deadline,
    progress: &Progress,
) {
    let outcome = execute(&mut sink, &plans, link, deadline, progress);
    let _ = link.reports.send(Report::Done(outcome));
}

fn execute(
    sink: &mut dyn X11Sink,
    plans: &[Plan],
    link: &Link,
    deadline: Deadline,
    progress: &Progress,
) -> Result<Delivery, AdapterError> {
    preflight(sink, plans)?;
    if let Some(journal) = &link.journal {
        journal.release_stale(sink)?;
    }
    let mut guard = ReleaseGuard::new(sink);
    guard.journal_to(link.journal.clone());
    for plan in plans {
        if !gate_passed(link) {
            let stopped = AdapterError::internal("The input call was stopped between steps");
            return Err(guard.abort(stopped, ABORT_SUGGESTION));
        }
        guard.set_origin(plan.release_origin);
        let outcome = run_plan(&mut guard, plan, deadline, progress);
        if let Err(error) = outcome {
            return Err(guard.abort(error, ABORT_SUGGESTION));
        }
    }
    if let Err(error) = guard.finish().map_err(SinkError::into_adapter) {
        return Err(guard.abort(error, ABORT_SUGGESTION));
    }
    let touched = guard.touched().clone();
    let delivered = guard.delivered();
    verify::check(guard.sink(), &touched, deadline).map_err(|error| {
        ReleaseState::resumed(delivered, false).enrich_error(error, ABORT_SUGGESTION)
    })?;
    Ok(Delivery {
        delivered_events: guard.delivered(),
    })
}

fn gate_passed(link: &Link) -> bool {
    link.reports.send(Report::Gate).is_ok() && link.proceed.recv().unwrap_or(false)
}

fn preflight(sink: &mut dyn X11Sink, plans: &[Plan]) -> Result<(), AdapterError> {
    if !plans
        .iter()
        .flat_map(|plan| &plan.steps)
        .any(|step| matches!(step, Step::MoveTo { .. }))
    {
        return Ok(());
    }
    let (width, height) = sink.root_size().map_err(SinkError::into_adapter)?;
    let (width, height) = (i32::from(width), i32::from(height));
    let outside = |step: &Step| {
        matches!(step, Step::MoveTo { x, y }
            if !(0..width).contains(x) || !(0..height).contains(y))
    };
    if plans.iter().flat_map(|plan| &plan.steps).any(outside) {
        return Err(AdapterError::new(
            ErrorCode::InvalidArgs,
            "A pointer position lies outside the screen",
        )
        .with_details(json!({ "screen_width": width, "screen_height": height }))
        .with_suggestion("Use a point inside the screen bounds")
        .with_disposition(agent_desktop_core::DeliverySemantics::not_delivered()));
    }
    Ok(())
}

fn run_plan(
    guard: &mut ReleaseGuard<'_>,
    plan: &Plan,
    deadline: Deadline,
    progress: &Progress,
) -> Result<(), AdapterError> {
    for step in &plan.steps {
        check_alive(deadline, progress, guard.delivered())?;
        run_step(guard, step, deadline, progress)?;
        progress.record(guard.delivered());
    }
    guard.sink().round_trip().map_err(SinkError::into_adapter)
}

fn run_step(
    guard: &mut ReleaseGuard<'_>,
    step: &Step,
    deadline: Deadline,
    progress: &Progress,
) -> Result<(), AdapterError> {
    if !matches!(step, Step::Pause(_) | Step::CheckTextState) && !progress.begin_dispatch() {
        return Err(mark_started(
            deadline.timeout_error(),
            progress.has_started(),
        ));
    }
    let sent = match step {
        Step::CheckTextState => {
            return guard.sink().ensure_text_state();
        }
        Step::Key { code, down } => guard.key(*code, *down),
        Step::Button { code, down } => guard.button(*code, *down),
        Step::MoveTo { x, y } => guard.move_to(*x, *y),
        Step::Pause(duration) => {
            guard.sink().round_trip().map_err(SinkError::into_adapter)?;
            return pause(*duration, deadline, progress, guard.delivered());
        }
        Step::Keymap(edit) => {
            return guard.edit_keymap(edit).map_err(SinkError::into_adapter);
        }
    };
    sent.map_err(SinkError::into_adapter)
}

fn check_alive(
    deadline: Deadline,
    progress: &Progress,
    delivered: u32,
) -> Result<(), AdapterError> {
    if progress.is_cancelled() || deadline.is_expired() {
        return Err(mark_started(
            deadline.timeout_error(),
            progress.has_started() || delivered > 0,
        ));
    }
    Ok(())
}

fn pause(
    duration: Duration,
    deadline: Deadline,
    progress: &Progress,
    delivered: u32,
) -> Result<(), AdapterError> {
    let mut left = duration;
    while !left.is_zero() {
        check_alive(deadline, progress, delivered)?;
        let slice = left.min(PAUSE_SLICE);
        thread::sleep(slice);
        left = left.saturating_sub(slice);
    }
    Ok(())
}

#[cfg(test)]
#[path = "worker_tests.rs"]
mod tests;

#[cfg(test)]
#[path = "worker_cancel_tests.rs"]
mod cancel_tests;
