//! `type --interval-ms`: types text one keystroke unit at a time on a steady
//! clock, inside one command. The first unit is a full ref action: strict
//! resolution, actionability, cursor travel and verification, and a headed one
//! also focuses the target's window. The burst then keeps that element for the
//! remaining units and takes the interaction lease only while each unit is
//! delivered, so other callers act between keystrokes and per-keystroke
//! resolution cannot make the rhythm uneven. Each unit still goes through the
//! adapter's own delivery checks, which for physical keystrokes confirm that the
//! target's process and focused element are unchanged before a key is posted.
//! The result is verified against the field as the last keystroke left it, and
//! a `--wait-for` condition is waited on once, after the last keystroke.

use std::time::{Duration, Instant};

use serde_json::{Value, json};

use crate::{
    AdapterError, AppError, DeliverySemantics,
    actions::action::Action,
    adapter::PlatformAdapter,
    commands::helpers::{RefArgs, execute_ref_action_with_context},
    commands::type_text::{TypeArgs, default_timeout_ms},
    context::CommandContext,
};

pub(crate) fn execute(
    args: TypeArgs,
    interval_ms: u64,
    adapter: &dyn PlatformAdapter,
    context: &CommandContext,
) -> Result<Value, AppError> {
    crate::commands::helpers::validate_post_action_wait(context)?;
    let per_keystroke = context.clone().with_wait_selector(None);
    let units = keystroke_units(&args.text);
    let mut clock = Clock {
        interval: Duration::from_millis(interval_ms),
        due: None,
    };
    let waits = args.timeout_ms != Some(0);
    let budget = |unit: &str| {
        args.timeout_ms
            .filter(|timeout_ms| *timeout_ms > 0)
            .unwrap_or_else(|| default_timeout_ms(unit))
    };
    let mut last = Value::Null;
    let mut burst: Option<Burst> = None;
    for (index, unit) in units.iter().enumerate() {
        let slot = clock.wait();
        let request = context.request_base(Action::TypeText(unit.clone()));
        let delivered = match &burst {
            Some(burst) => deliver(adapter, burst, request, budget(unit)).map(|_| {
                crate::ref_action::presentation::move_caret(adapter, context, &burst.handle);
            }),
            None => execute_ref_action_with_context(
                RefArgs {
                    ref_id: args.ref_id.clone(),
                    timeout_ms: waits.then(|| budget(unit)),
                },
                adapter,
                request,
                &per_keystroke,
            )
            .map(|value| last = value),
        };
        delivered.map_err(|error| after_partial_delivery(error, index, units.len()))?;
        clock.delivered(slot);
        if burst.is_none() && index + 1 < units.len() {
            burst = Some(
                resolve_for_burst(adapter, &args.ref_id, context, budget(unit))
                    .map_err(|error| after_partial_delivery(error, index + 1, units.len()))?,
            );
        }
    }
    if let Some(burst) = &burst {
        let expected = expected_final_value(&last, &units);
        super::type_text_interval_verify::verify_burst(
            &mut last,
            adapter,
            &burst.handle,
            expected.as_deref(),
        );
    }
    let value = with_keystrokes(last, units.len(), interval_ms);
    if context.wait_selector().is_none() {
        return Ok(value);
    }
    let entry = crate::commands::helpers::load_ref_entry(&args.ref_id, context)?;
    crate::commands::helpers::apply_post_action_wait(value, Some(&entry), adapter, context)
}

/// What the field should read once every keystroke has landed, when the first
/// keystroke's readback shows it was typed at the end of the field: that value
/// with the rest of the text after it. `None` when the field was not readable
/// or the text went in part way through it.
fn expected_final_value(first: &Value, units: &[String]) -> Option<String> {
    let after_first = first.pointer("/post_state/value")?.as_str()?;
    after_first
        .ends_with(units.first()?.as_str())
        .then(|| format!("{after_first}{}", units[1..].concat()))
}

/// Spaces keystrokes an interval apart. The grid slides rather than catching
/// up: a keystroke that is slow to land, or waits for the interaction lease,
/// pushes the rest back instead of letting them go out in a rush.
struct Clock {
    interval: Duration,
    due: Option<Instant>,
}

impl Clock {
    /// Waits until the next keystroke is due, and returns the slot it goes
    /// out in. The first keystroke goes at once.
    fn wait(&mut self) -> Instant {
        let Some(due) = self.due else {
            return Instant::now();
        };
        if let Some(wait) = due.checked_duration_since(Instant::now()) {
            std::thread::sleep(wait);
        }
        due
    }

    /// Schedules the next keystroke once the one sent in `slot` has landed.
    fn delivered(&mut self, slot: Instant) {
        self.due = Some(next_due(slot, Instant::now(), self.interval));
    }
}

/// When the keystroke after the one sent in `slot` is due, given that it
/// landed at `now`: an interval after its slot, or half an interval after it
/// landed when it landed late, so two keystrokes never land a frame apart.
fn next_due(slot: Instant, now: Instant, interval: Duration) -> Instant {
    (slot + interval).max(now + interval / 2)
}

/// The element the first keystroke resolved, and the process instance it
/// belongs to, which every later keystroke must still reach.
struct Burst {
    handle: crate::NativeHandle,
    process: Option<crate::ProcessIdentity>,
}

fn resolve_for_burst(
    adapter: &dyn PlatformAdapter,
    ref_id: &str,
    context: &CommandContext,
    timeout_ms: u64,
) -> Result<Burst, AppError> {
    let entry = crate::commands::helpers::load_ref_entry(ref_id, context)?;
    let deadline = crate::Deadline::after(timeout_ms)?;
    let handle = adapter.resolve_element_strict(&entry, deadline)?;
    let process = entry
        .process
        .process_instance
        .as_deref()
        .filter(|instance| !instance.is_empty())
        .map(|instance| crate::ProcessIdentity::new(entry.process.pid, instance));
    Ok(Burst { handle, process })
}

fn deliver(
    adapter: &dyn PlatformAdapter,
    burst: &Burst,
    request: crate::ActionRequest,
    timeout_ms: u64,
) -> Result<crate::ActionResult, AppError> {
    let request = match &burst.process {
        Some(process) => request.with_expected_process(process.clone()),
        None => request,
    };
    let deadline = crate::Deadline::after(timeout_ms)?;
    let lease = adapter.acquire_interaction_lease(deadline)?;
    Ok(adapter.execute_action(&burst.handle, request, &lease)?)
}

/// Splits text into the units one keystroke produces: a character together
/// with the combining marks, variation selectors, emoji modifiers and
/// zero-width-joined characters that render with it, and CR LF as one unit.
pub(crate) fn keystroke_units(text: &str) -> Vec<String> {
    let mut units: Vec<String> = Vec::new();
    let mut joining = false;
    for character in text.chars() {
        let attaches = joining
            || extends_previous(character)
            || (character == '\n' && units.last().is_some_and(|unit| unit == "\r"));
        match units.last_mut() {
            Some(unit) if attaches => unit.push(character),
            _ => units.push(character.to_string()),
        }
        joining = character == '\u{200D}';
    }
    units
}

fn extends_previous(character: char) -> bool {
    matches!(
        u32::from(character),
        0x0300..=0x036F
            | 0x1AB0..=0x1AFF
            | 0x1DC0..=0x1DFF
            | 0x20D0..=0x20FF
            | 0xFE00..=0xFE0F
            | 0xFE20..=0xFE2F
            | 0x200D
            | 0x1F3FB..=0x1F3FF
            | 0xE0020..=0xE007F
    )
}

fn after_partial_delivery(error: AppError, typed: usize, total: usize) -> AppError {
    if typed == 0 {
        return error;
    }
    let adapter_error = match error {
        AppError::Adapter(error) => error,
        other => AdapterError::internal(other.to_string()),
    };
    let mut details = adapter_error.details.clone().unwrap_or_else(|| json!({}));
    if let Some(object) = details.as_object_mut() {
        object.insert("typed_keystrokes".into(), json!(typed));
        object.insert("keystrokes".into(), json!(total));
    }
    AppError::Adapter(
        adapter_error
            .with_details(details)
            .with_disposition(DeliverySemantics::delivered_unverified()),
    )
}

fn with_keystrokes(mut value: Value, keystrokes: usize, interval_ms: u64) -> Value {
    if let Some(object) = value.as_object_mut() {
        object.insert("keystrokes".into(), json!(keystrokes));
        object.insert("interval_ms".into(), json!(interval_ms));
    }
    value
}

#[cfg(test)]
#[path = "type_text_interval_tests.rs"]
mod tests;
