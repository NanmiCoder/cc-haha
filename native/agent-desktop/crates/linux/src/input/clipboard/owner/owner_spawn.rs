use std::fs::File;
use std::io::{Read, Write};
use std::os::fd::OwnedFd;
use std::path::Path;
use std::process::Child;
use std::sync::{Arc, Mutex, PoisonError};
use std::thread::sleep;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use agent_desktop_core::{AdapterError, Deadline, DeliverySemantics, ErrorCode};
use rustix::fs::{MemfdFlags, memfd_create};

use super::owner_record::{self, Outcome, OwnerRecord};
use crate::input::clipboard::payload::{Payload, frame};

const FIRST_PAUSE: Duration = Duration::from_millis(2);
const LONGEST_PAUSE: Duration = Duration::from_millis(25);
const NONCE_BYTES: usize = 8;

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) enum Handshake {
    Ready(OwnerRecord),
    Failed(String),
    Exited(String),
    TimedOut,
}

pub(crate) trait HandshakeProbe {
    fn outcome(&mut self) -> Option<Outcome>;
    fn exit_reason(&mut self) -> Option<String>;
}

fn conclude(outcome: Outcome) -> Handshake {
    match outcome {
        Outcome::Ready(record) => Handshake::Ready(record),
        Outcome::Failed(message) => Handshake::Failed(message),
    }
}

/// Waits for the owner to publish its record, with a backoff that stays
/// inside the deadline. A child that has already gone is reported at once,
/// after one last look for a record it wrote on its way out.
pub(crate) fn await_handshake(probe: &mut dyn HandshakeProbe, deadline: Deadline) -> Handshake {
    let mut pause = FIRST_PAUSE;
    loop {
        if let Some(outcome) = probe.outcome() {
            return conclude(outcome);
        }
        if let Some(reason) = probe.exit_reason() {
            return probe.outcome().map_or(Handshake::Exited(reason), conclude);
        }
        if deadline.is_expired() {
            return Handshake::TimedOut;
        }
        sleep(pause.min(deadline.remaining()));
        pause = (pause * 2).min(LONGEST_PAUSE);
    }
}

pub(crate) struct ChildProbe<'a> {
    pub(crate) child: &'a mut Child,
    pub(crate) dir: &'a Path,
    pub(crate) display: &'a str,
    pub(crate) nonce: &'a str,
}

impl HandshakeProbe for ChildProbe<'_> {
    fn outcome(&mut self) -> Option<Outcome> {
        owner_record::read_outcome(self.dir, self.display, self.nonce)
    }

    fn exit_reason(&mut self) -> Option<String> {
        let status = self.child.try_wait().ok().flatten()?;
        Some(format!("the owner exited with {status}"))
    }
}

pub(crate) fn kill_and_reap(child: &mut Child) {
    let _ = child.kill();
    let _ = child.wait();
}

/// Collects the owner's exit status whenever it ends, so a long-lived host
/// that sets the clipboard many times keeps no zombies. The waiting thread
/// ends with the owner or with the host.
pub(crate) fn reap_when_done(child: Child) -> std::io::Result<()> {
    let child = Arc::new(Mutex::new(child));
    let waiting = Arc::clone(&child);
    std::thread::Builder::new()
        .name("clipboard-owner-reaper".to_owned())
        .spawn(move || {
            let _ = waiting
                .lock()
                .unwrap_or_else(PoisonError::into_inner)
                .wait();
        })
        .map(|_| ())
        .inspect_err(|_| {
            kill_and_reap(&mut child.lock().unwrap_or_else(PoisonError::into_inner));
        })
}

fn payload_error(message: String) -> AdapterError {
    AdapterError::new(ErrorCode::ActionFailed, message)
        .with_disposition(DeliverySemantics::not_delivered())
}

/// The payload as an anonymous in-memory file, close-on-exec for as long as
/// this process holds it so that no child another thread spawns can inherit
/// it. Nothing is ever on disk, and the descriptor closes when the returned
/// value drops, on every path.
pub(crate) fn payload_file(payload: &Payload, nonce: &str) -> Result<OwnedFd, AdapterError> {
    let descriptor = memfd_create(format!("ad-payload-{nonce}"), MemfdFlags::CLOEXEC)
        .map_err(|error| payload_error(format!("The payload file could not be made: {error}")))?;
    let mut file = File::from(descriptor);
    file.write_all(&frame(payload))
        .map_err(|error| payload_error(format!("The payload could not be written: {error}")))?;
    Ok(OwnedFd::from(file))
}

fn urandom_nonce() -> Option<String> {
    let mut bytes = [0u8; NONCE_BYTES];
    File::open("/dev/urandom")
        .ok()?
        .read_exact(&mut bytes)
        .ok()?;
    Some(bytes.iter().map(|byte| format!("{byte:02x}")).collect())
}

pub(crate) fn new_nonce() -> String {
    urandom_nonce().unwrap_or_else(|| {
        let nanos = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map_or(0, |elapsed| elapsed.as_nanos());
        format!("{:016x}", nanos ^ u128::from(std::process::id()))
    })
}

#[cfg(test)]
#[path = "owner_spawn_tests.rs"]
mod tests;
