use std::ops::Range;

use agent_desktop_core::{AdapterError, DeliverySemantics, ErrorCode, InteractionPolicy};

use super::mutation::{WriteReply, with_value_chars};
use super::secure_write::{guarded_read, scrub};
use crate::actions::chain::chain_delivery_outcome::DeliveryOutcome;
use crate::actions::chain::chain_observed::Observed;
use crate::actions::chain::chain_rung::Rung;
use crate::tree::capabilities::text_selection::CaretAndSelection;
use crate::tree::capabilities::text_units::{LengthUnit, insert_length};

pub(crate) const EDITABLE_TEXT: &str = "org.a11y.atspi.EditableText";
pub(crate) const REPLACE_LABEL: &str = "EditableText.SetTextContents";
pub(crate) const REWRITE_LABEL: &str = "EditableText.DeleteText+InsertText";
pub(crate) const INSERT_LABEL: &str = "EditableText.InsertText";

pub(crate) trait TextPort {
    fn set_contents(&self, text: &str) -> Result<WriteReply, AdapterError>;
    fn delete(&self, start: i32, end: i32) -> Result<WriteReply, AdapterError>;
    fn insert(&self, position: i32, text: &str, length: i32) -> Result<WriteReply, AdapterError>;
    fn read(&self) -> Option<String>;
    fn length_unit(&self) -> LengthUnit;
    fn caret(&self) -> Result<Option<CaretAndSelection>, AdapterError>;
}

pub(crate) fn writable(read_only: Option<bool>, editable: Option<bool>) -> bool {
    read_only != Some(true) && editable != Some(false)
}

pub(crate) fn read_only_field() -> AdapterError {
    AdapterError::new(ErrorCode::ActionNotSupported, "The field is read-only")
        .with_suggestion(
            "Choose an editable field; the toolkit would accept this write and ignore it",
        )
        .with_disposition(DeliverySemantics::not_delivered())
}

pub(crate) fn editable_text_ignored(policy: InteractionPolicy, action: &str) -> AdapterError {
    AdapterError::new(
        ErrorCode::ActionNotSupported,
        "This toolkit accepts EditableText writes and applies none of them",
    )
    .with_suggestion(if policy.is_headed() && action == "type" {
        "The headed physical route and semantic text writes are unavailable; choose another input-capable target"
    } else if policy.is_headed() {
        "Use 'type' in the current headed mode to send real key events; select the existing text first if you intend to replace it"
    } else {
        "Use '--headed type' to send real key events; select the existing text first if you intend to replace it"
    })
    .with_details(serde_json::json!({ "cause": "toolkit_ignores_editable_text" }))
    .with_disposition(DeliverySemantics::not_delivered())
}

fn too_long<E>(_: E) -> AdapterError {
    AdapterError::new(ErrorCode::InvalidArgs, "The text is too long to address")
        .with_disposition(DeliverySemantics::not_delivered())
}

fn offset(value: usize) -> Result<i32, AdapterError> {
    i32::try_from(value).map_err(too_long)
}

fn text_error(error: AdapterError, text: &str, secure: bool) -> AdapterError {
    with_value_chars(scrub(error, text, secure), text.chars().count())
}

pub(crate) fn write_ignored() -> AdapterError {
    AdapterError::new(
        ErrorCode::ActionFailed,
        "The field still holds its old text, so the write was not applied",
    )
    .with_suggestion("Use physical typing for this field")
    .with_details(serde_json::json!({ "cause": "write_ignored" }))
    .with_disposition(DeliverySemantics::not_delivered())
}

fn judge(
    port: &dyn TextPort,
    secure: bool,
    before: Option<&str>,
    expected: &str,
) -> Result<Observed, AdapterError> {
    match guarded_read(port, secure) {
        None => Ok(Observed::Unread),
        Some(read) if read == expected => Ok(Observed::Matched),
        Some(read) if before == Some(read.as_str()) => Err(write_ignored()),
        Some(_) => Ok(Observed::Unchanged),
    }
}

fn after_delete(cause: Option<AdapterError>) -> AdapterError {
    let uncertain = cause
        .as_ref()
        .is_some_and(|error| error.disposition == DeliverySemantics::uncertain());
    let disposition = if uncertain {
        DeliverySemantics::uncertain()
    } else {
        DeliverySemantics::delivered_unverified()
    };
    let error = AdapterError::new(
        ErrorCode::ActionFailed,
        "The old text was removed but the new text was not confirmed",
    )
    .with_disposition(disposition)
    .with_suggestion("Read the field before you retry: the old text may already be gone");
    match cause {
        Some(cause) => error.with_platform_detail(cause.message),
        None => error,
    }
}

pub(crate) fn replace_rungs<'a>(
    port: &'a dyn TextPort,
    text: &'a str,
    secure: bool,
) -> Vec<Rung<'a>> {
    let set = move || {
        let before = guarded_read(port, secure);
        match port
            .set_contents(text)
            .map_err(|error| text_error(error, text, secure))?
        {
            WriteReply::Absent => Ok(DeliveryOutcome::NotDelivered),
            WriteReply::Done => Ok(DeliveryOutcome::Delivered(judge(
                port,
                secure,
                before.as_deref(),
                text,
            )?)),
        }
    };
    let rewrite = move || rewrite(port, text, secure);
    vec![
        Rung {
            label: REPLACE_LABEL,
            run: Box::new(set),
        },
        Rung {
            label: REWRITE_LABEL,
            run: Box::new(rewrite),
        },
    ]
}

fn rewrite(port: &dyn TextPort, text: &str, secure: bool) -> Result<DeliveryOutcome, AdapterError> {
    let Some(old) = guarded_read(port, secure) else {
        return Ok(DeliveryOutcome::NotDelivered);
    };
    let count = old.chars().count();
    let removed = count > 0;
    if removed {
        match port.delete(0, offset(count)?) {
            Ok(WriteReply::Done) => {}
            Ok(WriteReply::Absent) => return Ok(DeliveryOutcome::NotDelivered),
            Err(error) => return Err(text_error(error, text, secure)),
        }
    }
    if text.is_empty() {
        let outcome = if removed {
            DeliveryOutcome::Delivered(judge(port, secure, None, text)?)
        } else {
            DeliveryOutcome::Satisfied
        };
        return Ok(outcome);
    }
    match port.insert(
        0,
        text,
        insert_length(text, port.length_unit()).map_err(too_long)?,
    ) {
        Ok(WriteReply::Done) => Ok(DeliveryOutcome::Delivered(judge(port, secure, None, text)?)),
        Ok(WriteReply::Absent) if removed => Err(after_delete(None)),
        Ok(WriteReply::Absent) => Ok(DeliveryOutcome::NotDelivered),
        Err(error) if removed => Err(text_error(after_delete(Some(error)), text, secure)),
        Err(error) => Err(text_error(error, text, secure)),
    }
}

pub(crate) fn expected_after(before: &str, replaced: Range<usize>, text: &str) -> Option<String> {
    let chars: Vec<char> = before.chars().collect();
    if replaced.start > replaced.end || replaced.end > chars.len() {
        return None;
    }
    let mut spliced: String = chars[..replaced.start].iter().collect();
    spliced.push_str(text);
    spliced.extend(&chars[replaced.end..]);
    Some(spliced)
}

fn unreadable_caret() -> AdapterError {
    AdapterError::new(
        ErrorCode::ActionFailed,
        "The caret position could not be read, so the text was not inserted",
    )
    .with_suggestion("Focus the field and retry, or use set-value to replace the whole text")
    .with_disposition(DeliverySemantics::not_delivered())
}

pub(crate) fn insert_rungs<'a>(
    port: &'a dyn TextPort,
    text: &'a str,
    secure: bool,
) -> Vec<Rung<'a>> {
    vec![Rung {
        label: INSERT_LABEL,
        run: Box::new(move || insert_at_caret(port, text, secure)),
    }]
}

fn insert_at_caret(
    port: &dyn TextPort,
    text: &str,
    secure: bool,
) -> Result<DeliveryOutcome, AdapterError> {
    if text.is_empty() {
        return Ok(DeliveryOutcome::Satisfied);
    }
    let Some((caret, selections)) = port.caret().map_err(|e| text_error(e, text, secure))? else {
        return Err(unreadable_caret());
    };
    let selected = selections.into_iter().find(|range| range.start < range.end);
    let before = guarded_read(port, secure);
    let replaced = selected.clone().unwrap_or(caret..caret);
    let removed = selected.is_some();
    if removed {
        match port.delete(offset(replaced.start)?, offset(replaced.end)?) {
            Ok(WriteReply::Done) => {}
            Ok(WriteReply::Absent) => return Ok(DeliveryOutcome::NotDelivered),
            Err(error) => return Err(text_error(error, text, secure)),
        }
    }
    let sent = port.insert(
        offset(replaced.start)?,
        text,
        insert_length(text, port.length_unit()).map_err(too_long)?,
    );
    let expected = before
        .as_deref()
        .and_then(|old| expected_after(old, replaced, text));
    match sent {
        Ok(WriteReply::Done) => Ok(DeliveryOutcome::Delivered(match expected {
            Some(expected) => judge(port, secure, before.as_deref(), &expected)?,
            None => Observed::Unread,
        })),
        Ok(WriteReply::Absent) if removed => Err(after_delete(None)),
        Ok(WriteReply::Absent) => Ok(DeliveryOutcome::NotDelivered),
        Err(error) if removed => Err(text_error(after_delete(Some(error)), text, secure)),
        Err(error) => Err(text_error(error, text, secure)),
    }
}

#[cfg(test)]
#[path = "text_write_fakes.rs"]
pub(crate) mod fakes;

#[cfg(test)]
#[path = "text_write_tests.rs"]
mod tests;
