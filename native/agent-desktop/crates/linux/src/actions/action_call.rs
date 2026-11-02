use agent_desktop_core::AdapterError;

use super::context::Target;
use super::write::mutation::{WriteKind, WriteReply};
use super::write::write_call::{Call, invoke};

const ACTION_INTERFACE: &str = "org.a11y.atspi.Action";

pub(crate) fn resolve_verb(names: &[String], verbs: &[&str]) -> Option<i32> {
    verbs
        .iter()
        .filter(|verb| !verb.is_empty())
        .find_map(|verb| {
            names
                .iter()
                .position(|name| name.eq_ignore_ascii_case(verb))
        })
        .and_then(|position| i32::try_from(position).ok())
}

pub(crate) fn do_action(
    target: &Target<'_>,
    names: &[String],
    verbs: &[&str],
) -> Result<WriteReply, AdapterError> {
    match resolve_verb(names, verbs) {
        Some(index) => invoke(
            target,
            Call {
                interface: ACTION_INTERFACE,
                method: "DoAction",
                body: &(index,),
                kind: WriteKind::DoAction,
            },
        ),
        None => Ok(WriteReply::Absent),
    }
}

#[cfg(test)]
#[path = "action_call_tests.rs"]
mod tests;
