use std::fs::File;
use std::io::Read;
use std::os::fd::{FromRawFd, OwnedFd};

use agent_desktop_core::MAX_PNG_INPUT_BYTES;

use crate::input::clipboard::payload::{Payload, unframe};

const LOWEST_INHERITED_FD: i32 = 3;
const TARGETS_PER_PAYLOAD: usize = 4;
const FRAMING_HEADROOM: usize = 1024 * 1024;

fn read_cap() -> u64 {
    (MAX_PNG_INPUT_BYTES * TARGETS_PER_PAYLOAD + FRAMING_HEADROOM) as u64
}

/// Takes ownership of the descriptor the setter inherited into this process.
/// Only a number above the standard streams that names an open descriptor is
/// adopted, and adopting it makes this the one place that closes it.
fn adopt(number: i32) -> Result<OwnedFd, String> {
    if number < LOWEST_INHERITED_FD {
        return Err(format!(
            "the payload descriptor {number} is not an inherited one"
        ));
    }
    std::fs::metadata(format!("/proc/self/fd/{number}"))
        .map_err(|_| format!("the payload descriptor {number} is not open"))?;
    Ok(unsafe { OwnedFd::from_raw_fd(number) })
}

/// Reads the whole payload from the inherited anonymous file and closes the
/// descriptor before returning, so the owner holds one copy of the data.
pub(crate) fn read_payload(descriptor: Option<&str>) -> Result<Payload, String> {
    let text = descriptor.ok_or("no payload descriptor was passed")?;
    let number: i32 = text
        .parse()
        .map_err(|_| format!("the payload descriptor {text:?} is not a number"))?;
    let owned = adopt(number)?;
    let mut file = File::open(format!("/proc/self/fd/{number}"))
        .map_err(|error| format!("the payload could not be reopened: {error}"))?;
    drop(owned);
    let mut bytes = Vec::new();
    file.by_ref()
        .take(read_cap() + 1)
        .read_to_end(&mut bytes)
        .map_err(|error| format!("the payload could not be read: {error}"))?;
    if bytes.len() as u64 > read_cap() {
        return Err("the payload is over the size cap".to_owned());
    }
    unframe(&bytes).map_err(|error| error.message)
}

#[cfg(test)]
#[path = "owner_payload_tests.rs"]
mod tests;
