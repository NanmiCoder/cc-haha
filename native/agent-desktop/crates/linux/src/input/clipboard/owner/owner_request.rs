use std::collections::HashMap;
use std::sync::Arc;
use std::time::{Duration, Instant};

use crate::input::clipboard::incr::IncrSender;

/// The atoms the owner answers with, resolved once by the connection.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) struct Atoms {
    pub(crate) clipboard: u32,
    pub(crate) targets: u32,
    pub(crate) timestamp: u32,
    pub(crate) incr: u32,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) struct Request {
    pub(crate) requestor: u32,
    pub(crate) selection: u32,
    pub(crate) target: u32,
    pub(crate) property: u32,
    pub(crate) time: u32,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) enum Reply {
    Refuse,
    Atoms {
        property: u32,
        atoms: Vec<u32>,
    },
    Integer {
        property: u32,
        value: u32,
    },
    Bytes {
        property: u32,
        kind: u32,
        data: Vec<u8>,
    },
    StartIncr {
        property: u32,
        kind: u32,
        total: u32,
    },
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct Served {
    pub(crate) atom: u32,
    pub(crate) bytes: Arc<[u8]>,
}

/// The pure answer to one `SelectionRequest`: what the owner serves, when it
/// claimed the selection, and the size above which a value goes by INCR.
#[derive(Debug, Clone)]
pub(crate) struct Answerer {
    pub(crate) atoms: Atoms,
    pub(crate) served: Vec<Served>,
    pub(crate) claim_time: u32,
    pub(crate) incr_threshold: usize,
}

impl Answerer {
    pub(crate) fn shared_bytes_of(&self, atom: u32) -> Option<Arc<[u8]>> {
        self.served
            .iter()
            .find(|served| served.atom == atom)
            .map(|served| Arc::clone(&served.bytes))
    }

    /// A request with no property comes from an obsolete client and names the
    /// target as the property.
    pub(crate) fn answer(&self, request: &Request) -> Reply {
        if request.selection != self.atoms.clipboard {
            return Reply::Refuse;
        }
        let property = if request.property == 0 {
            request.target
        } else {
            request.property
        };
        if request.target == self.atoms.targets {
            let mut atoms: Vec<u32> = self.served.iter().map(|served| served.atom).collect();
            atoms.push(self.atoms.targets);
            atoms.push(self.atoms.timestamp);
            return Reply::Atoms { property, atoms };
        }
        if request.target == self.atoms.timestamp {
            return Reply::Integer {
                property,
                value: self.claim_time,
            };
        }
        let Some(served) = self
            .served
            .iter()
            .find(|served| served.atom == request.target)
        else {
            return Reply::Refuse;
        };
        if served.bytes.len() > self.incr_threshold {
            return Reply::StartIncr {
                property,
                kind: served.atom,
                total: u32::try_from(served.bytes.len()).unwrap_or(u32::MAX),
            };
        }
        Reply::Bytes {
            property,
            kind: served.atom,
            data: served.bytes.to_vec(),
        }
    }
}

#[derive(Debug, PartialEq, Eq)]
pub(crate) struct Chunk {
    pub(crate) requestor: u32,
    pub(crate) property: u32,
    pub(crate) kind: u32,
    pub(crate) data: Vec<u8>,
}

pub(crate) const MAX_TRANSFERS: usize = 8;
pub(crate) const TRANSFER_IDLE: Duration = Duration::from_secs(30);

struct Transfer {
    kind: u32,
    sender: IncrSender,
    touched: Instant,
}

/// The INCR transfers in flight, one per requestor window and property, each
/// advanced by that requestor deleting the last chunk.
#[derive(Default)]
pub(crate) struct Transfers {
    active: HashMap<(u32, u32), Transfer>,
}

impl Transfers {
    /// Starts a transfer, or says it is refused because `MAX_TRANSFERS` others
    /// are in flight. A transfer for a requestor and property that already has
    /// one replaces it and does not count twice.
    pub(crate) fn start(
        &mut self,
        requestor: u32,
        property: u32,
        kind: u32,
        sender: IncrSender,
    ) -> bool {
        let key = (requestor, property);
        if !self.active.contains_key(&key) && self.active.len() >= MAX_TRANSFERS {
            return false;
        }
        self.active.insert(
            key,
            Transfer {
                kind,
                sender,
                touched: Instant::now(),
            },
        );
        true
    }

    /// Drops the transfers that no requestor advanced for `idle`.
    pub(crate) fn expire(&mut self, idle: Duration) {
        self.active
            .retain(|_, transfer| transfer.touched.elapsed() < idle);
    }

    /// The next chunk once `requestor` deleted `property`. The transfer is
    /// forgotten after its zero-length chunk.
    pub(crate) fn on_property_deleted(&mut self, requestor: u32, property: u32) -> Option<Chunk> {
        let key = (requestor, property);
        let transfer = self.active.get_mut(&key)?;
        transfer.touched = Instant::now();
        let kind = transfer.kind;
        let data = transfer.sender.next_chunk()?;
        if data.is_empty() {
            self.active.remove(&key);
        }
        Some(Chunk {
            requestor,
            property,
            kind,
            data,
        })
    }

    pub(crate) fn drop_requestor(&mut self, requestor: u32) {
        self.active.retain(|(window, _), _| *window != requestor);
    }
}

#[cfg(test)]
#[path = "owner_request_tests.rs"]
mod tests;
