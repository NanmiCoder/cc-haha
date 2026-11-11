use super::owner_request::{Answerer, Chunk, Reply, Request, TRANSFER_IDLE, Transfers};
use crate::input::clipboard::incr::IncrSender;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum OwnerEvent {
    Request(Request),
    Cleared,
    PropertyDeleted { window: u32, property: u32 },
    WindowGone(u32),
    Other,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) struct Lost;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum Ended {
    Cleared,
    ConnectionLost,
}

/// The owner's side of the X connection. Answering a requestor that has
/// gone is not an error here: the server reports it as an event and the loop
/// carries on.
pub(crate) trait Wire {
    fn next_event(&mut self) -> Result<OwnerEvent, Lost>;
    fn send_reply(&mut self, request: &Request, reply: &Reply);
    fn send_chunk(&mut self, chunk: &Chunk);
}

/// Serves the selection until another client takes it or the connection is
/// lost. There is no timer: an owner that is never asked stays an owner.
pub(crate) fn serve(wire: &mut dyn Wire, answerer: &Answerer, chunk_bytes: usize) -> Ended {
    let mut transfers = Transfers::default();
    loop {
        let event = match wire.next_event() {
            Ok(event) => event,
            Err(Lost) => return Ended::ConnectionLost,
        };
        match event {
            OwnerEvent::Cleared => return Ended::Cleared,
            OwnerEvent::Request(request) => {
                transfers.expire(TRANSFER_IDLE);
                let mut reply = answerer.answer(&request);
                if let Reply::StartIncr { property, kind, .. } = &reply {
                    let started = answerer
                        .shared_bytes_of(request.target)
                        .is_some_and(|data| {
                            transfers.start(
                                request.requestor,
                                *property,
                                *kind,
                                IncrSender::new(data, chunk_bytes),
                            )
                        });
                    if !started {
                        reply = Reply::Refuse;
                    }
                }
                wire.send_reply(&request, &reply);
            }
            OwnerEvent::PropertyDeleted { window, property } => {
                if let Some(chunk) = transfers.on_property_deleted(window, property) {
                    wire.send_chunk(&chunk);
                }
            }
            OwnerEvent::WindowGone(window) => transfers.drop_requestor(window),
            OwnerEvent::Other => {}
        }
    }
}

#[cfg(test)]
#[path = "owner_serve_tests.rs"]
mod tests;
