use std::collections::VecDeque;

use super::*;
use crate::input::clipboard::owner::owner_request::{Atoms, Served};

const CLIPBOARD: u32 = 100;
const UTF8: u32 = 200;

struct Script {
    events: VecDeque<OwnerEvent>,
    replies: Vec<Reply>,
    chunks: Vec<Chunk>,
}

impl Script {
    fn new(events: Vec<OwnerEvent>) -> Self {
        Self {
            events: events.into(),
            replies: Vec::new(),
            chunks: Vec::new(),
        }
    }
}

impl Wire for Script {
    fn next_event(&mut self) -> Result<OwnerEvent, Lost> {
        self.events.pop_front().ok_or(Lost)
    }

    fn send_reply(&mut self, _request: &Request, reply: &Reply) {
        self.replies.push(reply.clone());
    }

    fn send_chunk(&mut self, chunk: &Chunk) {
        self.chunks.push(Chunk {
            requestor: chunk.requestor,
            property: chunk.property,
            kind: chunk.kind,
            data: chunk.data.clone(),
        });
    }
}

fn answerer(text: &[u8], threshold: usize) -> Answerer {
    Answerer {
        atoms: Atoms {
            clipboard: CLIPBOARD,
            targets: 101,
            timestamp: 102,
            incr: 103,
        },
        served: vec![Served {
            atom: UTF8,
            bytes: text.to_vec().into(),
        }],
        claim_time: 1,
        incr_threshold: threshold,
    }
}

fn ask(requestor: u32, property: u32) -> OwnerEvent {
    OwnerEvent::Request(Request {
        requestor,
        selection: CLIPBOARD,
        target: UTF8,
        property,
        time: 3,
    })
}

#[test]
fn the_loop_ends_when_another_client_takes_the_selection() {
    let mut wire = Script::new(vec![ask(1, 50), OwnerEvent::Cleared, ask(2, 51)]);
    let ended = serve(&mut wire, &answerer(b"hi", 1024), 4);
    assert_eq!(ended, Ended::Cleared);
    assert_eq!(wire.replies.len(), 1);
}

#[test]
fn the_loop_ends_when_the_connection_is_lost() {
    let mut wire = Script::new(vec![ask(1, 50)]);
    assert_eq!(
        serve(&mut wire, &answerer(b"hi", 1024), 4),
        Ended::ConnectionLost
    );
}

#[test]
fn an_incr_transfer_sends_a_chunk_per_delete_and_a_zero_chunk_last() {
    let delete = OwnerEvent::PropertyDeleted {
        window: 1,
        property: 50,
    };
    let mut wire = Script::new(vec![
        ask(1, 50),
        delete,
        delete,
        delete,
        delete,
        OwnerEvent::Cleared,
    ]);
    serve(&mut wire, &answerer(b"abcdef", 4), 4);
    assert!(matches!(wire.replies[0], Reply::StartIncr { total: 6, .. }));
    let sent: Vec<&[u8]> = wire
        .chunks
        .iter()
        .map(|chunk| chunk.data.as_slice())
        .collect();
    assert_eq!(sent, [b"abcd".as_slice(), b"ef", b""]);
}

#[test]
fn a_requestor_destroyed_mid_transfer_does_not_end_the_owner() {
    let delete = OwnerEvent::PropertyDeleted {
        window: 1,
        property: 50,
    };
    let mut wire = Script::new(vec![
        ask(1, 50),
        OwnerEvent::WindowGone(1),
        delete,
        ask(2, 60),
        OwnerEvent::Cleared,
    ]);
    assert_eq!(serve(&mut wire, &answerer(b"abcdef", 4), 4), Ended::Cleared);
    assert!(
        wire.chunks.is_empty(),
        "no chunk goes to a destroyed window"
    );
    assert_eq!(wire.replies.len(), 2);
}

#[test]
fn a_small_value_is_answered_in_one_reply_with_no_transfer() {
    let delete = OwnerEvent::PropertyDeleted {
        window: 1,
        property: 50,
    };
    let mut wire = Script::new(vec![ask(1, 50), delete, OwnerEvent::Cleared]);
    serve(&mut wire, &answerer(b"hi", 1024), 4);
    assert!(matches!(wire.replies[0], Reply::Bytes { .. }));
    assert!(wire.chunks.is_empty());
}

#[test]
fn the_ninth_concurrent_incr_request_is_refused() {
    let mut events: Vec<OwnerEvent> = (1..=9).map(|requestor| ask(requestor, 50)).collect();
    events.push(OwnerEvent::Cleared);
    let mut wire = Script::new(events);
    serve(&mut wire, &answerer(b"abcdef", 4), 4);
    assert_eq!(wire.replies.len(), 9);
    assert!(
        wire.replies[..8]
            .iter()
            .all(|reply| matches!(reply, Reply::StartIncr { .. }))
    );
    assert_eq!(wire.replies[8], Reply::Refuse);
}
