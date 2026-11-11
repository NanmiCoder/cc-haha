use agent_desktop_core::{
    AdapterError, ClipboardContent, ClipboardFormat, Deadline, DeliverySemantics, ErrorCode,
    MAX_PNG_INPUT_BYTES,
};
use serde_json::json;

use super::targets::{Wanted, choose_target, content_of};
use super::x11_requestor::X11Requestor;
use crate::system::display::display_server;
use crate::system::x11::{self, MonitorFault};

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) enum Fault {
    Timeout,
    Connect(MonitorFault),
    Protocol(String),
    OverCap,
    MutationUnconfirmed,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) enum Converted {
    Refused,
    Value(Vec<u8>),
    Incr,
}

pub(crate) trait Requestor {
    fn offered(&mut self, deadline: Deadline) -> Result<Option<Vec<String>>, Fault>;
    fn request(&mut self, target: &str, deadline: Deadline) -> Result<Converted, Fault>;
    fn next_chunk(&mut self, deadline: Deadline) -> Result<Vec<u8>, Fault>;
    fn owner_pid(&mut self) -> Option<u32>;
}

const INNER_DEADLINE_SHARE: u32 = 10;

pub(crate) fn fault_error(fault: Fault, owner_pid: Option<u32>) -> AdapterError {
    let error = match fault {
        Fault::MutationUnconfirmed => {
            return AdapterError::timeout("The clipboard change did not finish in time")
                .with_disposition(DeliverySemantics::uncertain());
        }
        Fault::Timeout => {
            let error = AdapterError::timeout("The clipboard owner did not answer in time");
            match owner_pid {
                Some(pid) => error.with_details(json!({ "owner_pid": pid })),
                None => error,
            }
        }
        Fault::Connect(fault) => display_server::fault_error("X11", Some(fault)),
        Fault::Protocol(message) => AdapterError::new(ErrorCode::ActionFailed, message),
        Fault::OverCap => AdapterError::new(
            ErrorCode::ActionFailed,
            format!(
                "The clipboard holds more than the {} MiB cap",
                MAX_PNG_INPUT_BYTES / (1024 * 1024)
            ),
        ),
    };
    error.with_disposition(DeliverySemantics::not_delivered())
}

fn collect_incr(requestor: &mut dyn Requestor, deadline: Deadline) -> Result<Vec<u8>, Fault> {
    let mut bytes = Vec::new();
    loop {
        let chunk = requestor.next_chunk(deadline)?;
        if chunk.is_empty() {
            return Ok(bytes);
        }
        if chunk.len() > MAX_PNG_INPUT_BYTES - bytes.len() {
            return Err(Fault::OverCap);
        }
        bytes.extend_from_slice(&chunk);
    }
}

fn fetch(
    requestor: &mut dyn Requestor,
    format: ClipboardFormat,
    deadline: Deadline,
) -> Result<Option<(Wanted, Vec<u8>)>, Fault> {
    let Some(offered) = requestor.offered(deadline)? else {
        return Ok(None);
    };
    let Some(wanted) = choose_target(&offered, format) else {
        return Ok(None);
    };
    let bytes = match requestor.request(wanted.target_name(), deadline)? {
        Converted::Refused => return Ok(None),
        Converted::Value(bytes) => bytes,
        Converted::Incr => collect_incr(requestor, deadline)?,
    };
    Ok(Some((wanted, bytes)))
}

/// Reads what the selection owner holds, in the shape `format` asks for.
/// No owner, a target the owner does not offer and a refused conversion all
/// read as absent; an empty text is a value.
pub(crate) fn read_with(
    requestor: &mut dyn Requestor,
    format: ClipboardFormat,
    deadline: Deadline,
) -> Result<Option<ClipboardContent>, AdapterError> {
    let fetched = match fetch(requestor, format, deadline) {
        Ok(fetched) => fetched,
        Err(fault) => {
            let pid = matches!(fault, Fault::Timeout)
                .then(|| requestor.owner_pid())
                .flatten();
            return Err(fault_error(fault, pid));
        }
    };
    let Some((wanted, bytes)) = fetched else {
        return Ok(None);
    };
    match content_of(&wanted, bytes)
        .map_err(|error| error.with_disposition(DeliverySemantics::not_delivered()))?
    {
        ClipboardContent::FileUrls(paths) if paths.is_empty() => Ok(None),
        content => Ok(Some(content)),
    }
}

pub(crate) fn read_x11(
    display: &str,
    format: ClipboardFormat,
    deadline: Deadline,
) -> Result<Option<ClipboardContent>, AdapterError> {
    let remaining = deadline.remaining();
    let inner = deadline.capped(remaining - remaining / INNER_DEADLINE_SHARE);
    let display_name = display.to_owned();
    x11::start(move || {
        let mut requestor =
            X11Requestor::connect(&display_name).map_err(|fault| fault_error(fault, None))?;
        read_with(&mut requestor, format, inner)
    })
    .finish(deadline)
    .unwrap_or_else(|| Err(fault_error(Fault::Timeout, None)))
}

#[cfg(test)]
#[path = "x11_read_tests.rs"]
mod tests;
