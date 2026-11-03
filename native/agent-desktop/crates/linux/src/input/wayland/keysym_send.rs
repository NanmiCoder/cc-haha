use std::thread::sleep;
use std::time::Duration;

use agent_desktop_core::{AdapterError, Deadline, DeliverySemantics};
use serde_json::json;

use super::kept_session;
use super::key_session::KeySession;
use super::layout::refuse_unreachable;
use super::remote_desktop::{RemoteDesktop, semantic_action_refusal};
use crate::input::delivery::{Delivery, Gate};
use crate::input::keyboard::key_names::KEYSYM_SHIFT_L;
use crate::input::keyboard::keysym_step::KeysymStep;

const RECOVERY_BUDGET_MS: u64 = 1_000;
const DRAIN: Duration = Duration::from_millis(150);
const SHIFT_SETTLE: Duration = Duration::from_millis(100);

fn with_fields(error: AdapterError, fields: serde_json::Value) -> AdapterError {
    let mut details = error.details.clone().unwrap_or_else(|| json!({}));
    if let (Some(map), Some(extra)) = (details.as_object_mut(), fields.as_object()) {
        map.extend(
            extra
                .iter()
                .map(|(key, value)| (key.clone(), value.clone())),
        );
    }
    error.with_details(details)
}

fn with_progress(mut error: AdapterError, delivered_events: u32) -> AdapterError {
    if delivered_events > 0 || error.disposition == DeliverySemantics::uncertain() {
        error.message = if delivered_events == 0 {
            "A keyboard event was attempted but its delivery could not be confirmed".to_owned()
        } else {
            format!(
                "At least {delivered_events} keyboard events were confirmed before Wayland delivery stopped (including any bootstrap keys); further delivery is uncertain"
            )
        };
        error.suggestion = Some(
            "Read the target's state before retrying; keyboard input may already have been sent"
                .to_owned(),
        );
        return with_fields(
            error,
            json!({
                "physical_delivery_started": true,
                "delivered_events": delivered_events,
            }),
        )
        .with_disposition(DeliverySemantics::uncertain());
    }
    if error.disposition != DeliverySemantics::Unknown {
        return error;
    }
    with_fields(error, json!({ "physical_delivery_started": false }))
        .with_disposition(DeliverySemantics::not_delivered())
}

fn recover(session: &mut dyn KeySession, held: &[u32]) {
    let Ok(deadline) = Deadline::detached_after(RECOVERY_BUDGET_MS) else {
        return;
    };
    for keysym in held.iter().rev() {
        let _ = session.keysym(*keysym, false, deadline);
    }
}

fn send_each(
    session: &mut dyn KeySession,
    keys: &[KeysymStep],
    already_delivered: u32,
    gate: Gate<'_>,
    deadline: Deadline,
) -> Result<u32, AdapterError> {
    let mut held: Vec<u32> = Vec::new();
    let mut delivered = 0_u32;
    for key in keys {
        let outcome = deadline.ensure_remaining().and_then(|()| {
            if key.down {
                gate()?;
            }
            session
                .keysym(key.keysym, key.down, deadline)
                .map_err(|error| {
                    if error.disposition != DeliverySemantics::Unknown {
                        return error;
                    }
                    with_fields(
                        error,
                        json!({
                            "physical_delivery_started": true,
                            "delivered_events": already_delivered + delivered,
                        }),
                    )
                    .with_disposition(DeliverySemantics::uncertain())
                })
        });
        if let Err(error) = outcome {
            recover(session, &held);
            return Err(with_progress(error, already_delivered + delivered));
        }
        delivered += 1;
        if key.down {
            held.push(key.keysym);
        } else if let Some(at) = held.iter().rposition(|keysym| *keysym == key.keysym) {
            held.remove(at);
        }
    }
    Ok(delivered)
}

fn drive(
    session: &mut dyn KeySession,
    chunks: &[&[KeysymStep]],
    gate: Gate<'_>,
    deadline: Deadline,
) -> Result<u32, AdapterError> {
    deadline
        .ensure_remaining()
        .map_err(|error| with_progress(error, 0))?;
    let mut lead_delivered = 0;
    if !session.resumed() {
        session
            .start(deadline)
            .map_err(|error| with_progress(error, 0))?;
        gate().map_err(|error| with_progress(error, 0))?;
        let shift = [
            KeysymStep {
                keysym: KEYSYM_SHIFT_L,
                down: true,
            },
            KeysymStep {
                keysym: KEYSYM_SHIFT_L,
                down: false,
            },
        ];
        lead_delivered = send_each(session, &shift, 0, gate, deadline)?;
        sleep(
            deadline
                .remaining_slice(SHIFT_SETTLE)
                .map_err(|error| with_progress(error, lead_delivered))?,
        );
    }
    let mut delivered = 0_u32;
    for chunk in chunks {
        gate().map_err(|error| with_progress(error, lead_delivered + delivered))?;
        delivered += send_each(session, chunk, lead_delivered + delivered, gate, deadline)?;
    }
    Ok(delivered)
}

pub(crate) fn run_chunks(
    session: &mut dyn KeySession,
    chunks: &[&[KeysymStep]],
    gate: Gate<'_>,
    deadline: Deadline,
) -> Result<Delivery, AdapterError> {
    if !session.resumed() {
        session
            .create(deadline)
            .map_err(|error| with_progress(error, 0))?;
    }
    let outcome = drive(session, chunks, gate, deadline);
    if outcome.as_ref().is_ok_and(|delivered| *delivered > 0) {
        sleep(deadline.remaining().min(DRAIN));
    }
    let kept = outcome.is_ok() && session.retain();
    if !kept && let Ok(recovery) = Deadline::detached_after(RECOVERY_BUDGET_MS) {
        let _ = session.stop(recovery);
    }
    outcome.map(|delivered_events| Delivery { delivered_events })
}

pub(crate) fn send_chunks(
    chunks: &[Vec<KeysymStep>],
    gate: Gate<'_>,
    deadline: Deadline,
) -> Result<Delivery, AdapterError> {
    for chunk in chunks {
        refuse_unreachable(chunk)?;
    }
    let chunks: Vec<&[KeysymStep]> = chunks
        .iter()
        .map(Vec::as_slice)
        .filter(|chunk| !chunk.is_empty())
        .collect();
    if chunks.is_empty() {
        return Ok(Delivery {
            delivered_events: 0,
        });
    }
    let kept = kept_session::take();
    let reused = kept.is_some();
    let mut session = match kept {
        Some(session) => session,
        None => RemoteDesktop::open(deadline).map_err(|error| with_progress(error, 0))?,
    };
    let mut outcome = run_chunks(&mut session, &chunks, gate, deadline);
    if reused && outcome.as_ref().is_err_and(sent_nothing) {
        session = RemoteDesktop::open(deadline).map_err(|error| with_progress(error, 0))?;
        outcome = run_chunks(&mut session, &chunks, gate, deadline);
    }
    if outcome.is_ok() && session.resumed() {
        kept_session::keep(session);
    }
    outcome
}

fn sent_nothing(error: &AdapterError) -> bool {
    error.disposition == DeliverySemantics::not_delivered()
}

pub(crate) fn pointer_refusal(what: &'static str) -> AdapterError {
    semantic_action_refusal(format!(
        "{what} is not available through the compositor on Wayland"
    ))
    .with_details(json!({
        "cause": "wayland_session",
        "physical_delivery_started": false,
    }))
}

#[cfg(test)]
#[path = "keysym_send_tests.rs"]
mod tests;
