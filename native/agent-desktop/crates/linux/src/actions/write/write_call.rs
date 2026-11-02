use std::cell::Cell;
use std::io::ErrorKind;

use agent_desktop_core::AdapterError;
use zbus::Message;
use zbus::export::serde::Serialize;
use zbus::zvariant::DynamicType;

use super::mutation::{
    Abort, Corroboration, Fault, Verdict, WriteKind, WriteReply, abort_error, classify_write,
    deadline_error, fault_of,
};
use crate::actions::context::Target;
use crate::system::within;
use crate::tree::capabilities::action_read::corroborate;

fn read_reply(message: &Message, kind: WriteKind) -> Result<WriteReply, AdapterError> {
    if !kind.returns_flag() {
        return Ok(WriteReply::Done);
    }
    match message.body().deserialize::<bool>() {
        Ok(true) => Ok(WriteReply::Done),
        Ok(false) => Ok(WriteReply::Absent),
        Err(error) => Err(abort_error(Abort::Uncertain, kind, Some(&error))),
    }
}

fn connection_lost(error: &zbus::Error) -> bool {
    matches!(error, zbus::Error::InputOutput(io) if io.kind() != ErrorKind::TimedOut)
}

fn judge_failure(
    target: &Target<'_>,
    error: &zbus::Error,
    kind: WriteKind,
) -> Result<WriteReply, AdapterError> {
    let fault = fault_of(error);
    let corroboration = if matches!(fault, Fault::ObjectUnknown | Fault::InterfaceMissing) {
        corroborate(target.bus, target.element, target.deadline)
    } else {
        Corroboration::NotRead
    };
    match classify_write(fault, kind, corroboration) {
        Verdict::Absent => Ok(WriteReply::Absent),
        Verdict::Abort(abort) => Err(abort_error(abort, kind, Some(error))),
    }
}

pub(crate) struct Call<'a, B> {
    pub(crate) interface: &'static str,
    pub(crate) method: &'static str,
    pub(crate) body: &'a B,
    pub(crate) kind: WriteKind,
}

pub(crate) fn invoke<B: Serialize + DynamicType>(
    target: &Target<'_>,
    call: Call<'_, B>,
) -> Result<WriteReply, AdapterError> {
    let Call {
        interface,
        method,
        body,
        kind,
    } = call;
    target
        .deadline
        .ensure_remaining()
        .map_err(|error| deadline_error(error, false))?;
    let connection = target
        .bus
        .get(target.deadline)
        .map_err(|error| deadline_error(error, false))?;
    let sent = Cell::new(false);
    let element = target.element;
    let outcome = within(target.deadline, async {
        sent.set(true);
        Ok(connection
            .inner()
            .call_method(
                Some(element.bus_name()),
                element.path(),
                Some(interface),
                method,
                body,
            )
            .await)
    })
    .map_err(|error| deadline_error(error, sent.get()))?;
    match outcome {
        Ok(message) => read_reply(&message, kind),
        Err(error) => {
            if connection_lost(&error) {
                target.bus.forget(&connection);
            }
            judge_failure(target, &error, kind)
        }
    }
}

#[cfg(test)]
#[path = "write_call_tests.rs"]
mod tests;
