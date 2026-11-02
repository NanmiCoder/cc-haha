//! Verifies a `type --interval-ms` burst against the field it typed into.
//!
//! The burst's result starts as the first keystroke's, verified against the
//! field as that keystroke left it. The later keystrokes go straight to the
//! adapter, so the field is read once more after the last one: a verified
//! result stays verified only when that read shows the whole text, and is
//! otherwise reported `delivered_unverified` with the reason. A failed read
//! drops the first keystroke's field rather than reporting it as the last.

use serde_json::{Value, json};
use std::time::Duration;

use crate::{DeliverySemantics, adapter::PlatformAdapter};

/// How long keystrokes still in the app's event queue may take to show up in
/// the field before the burst is reported unverified.
const SETTLE: Duration = Duration::from_millis(500);
const POLL: Duration = Duration::from_millis(25);

pub(crate) fn verify_burst(
    result: &mut Value,
    adapter: &dyn PlatformAdapter,
    handle: &crate::NativeHandle,
    expected: Option<&str>,
) {
    let read = || {
        let deadline = crate::Deadline::after(1_000).ok()?;
        adapter.get_live_element(handle, deadline).ok()
    };
    let started = std::time::Instant::now();
    let mut live = read();
    while expected.is_some()
        && live.as_ref().and_then(|live| live.state.value.as_deref()) != expected
        && started.elapsed() < SETTLE
    {
        std::thread::sleep(POLL);
        live = read();
    }
    let Some(object) = result.as_object_mut() else {
        return;
    };
    let reason = match &live {
        Some(live) => {
            object.insert("post_state".into(), json!(live.state));
            match expected {
                Some(text) if live.state.value.as_deref() == Some(text) => return,
                Some(_) => "postcondition_mismatch",
                None => "insufficient_evidence",
            }
        }
        None => {
            object.remove("post_state");
            "final_read_failed"
        }
    };
    let verified = json!(DeliverySemantics::delivered_verified());
    if object.get("disposition") != Some(&verified) {
        return;
    }
    object.insert(
        "disposition".into(),
        json!(DeliverySemantics::delivered_unverified()),
    );
    let details = object.entry("details").or_insert_with(|| json!({}));
    if let Some(details) = details.as_object_mut() {
        details.insert("verification_scope".into(), "unavailable".into());
        details.insert("verification_reason".into(), reason.into());
    }
}

#[cfg(test)]
#[path = "type_text_interval_verify_tests.rs"]
mod tests;
