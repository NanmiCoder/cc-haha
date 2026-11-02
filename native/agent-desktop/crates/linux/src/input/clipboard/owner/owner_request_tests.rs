use super::*;

const CLIPBOARD: u32 = 100;
const TARGETS: u32 = 101;
const TIMESTAMP: u32 = 102;
const INCR: u32 = 103;
const UTF8: u32 = 200;
const PLAIN: u32 = 201;

fn answerer(threshold: usize, text: &[u8]) -> Answerer {
    Answerer {
        atoms: Atoms {
            clipboard: CLIPBOARD,
            targets: TARGETS,
            timestamp: TIMESTAMP,
            incr: INCR,
        },
        served: vec![
            Served {
                atom: UTF8,
                bytes: text.to_vec().into(),
            },
            Served {
                atom: PLAIN,
                bytes: text.to_vec().into(),
            },
        ],
        claim_time: 777,
        incr_threshold: threshold,
    }
}

fn request(requestor: u32, target: u32, property: u32) -> Request {
    Request {
        requestor,
        selection: CLIPBOARD,
        target,
        property,
        time: 5,
    }
}

#[test]
fn targets_lists_what_is_served_plus_targets_and_timestamp() {
    let reply = answerer(1024, b"hi").answer(&request(1, TARGETS, 50));
    assert_eq!(
        reply,
        Reply::Atoms {
            property: 50,
            atoms: vec![UTF8, PLAIN, TARGETS, TIMESTAMP]
        }
    );
}

#[test]
fn an_unserved_target_is_refused() {
    assert_eq!(
        answerer(1024, b"hi").answer(&request(1, 999, 50)),
        Reply::Refuse
    );
}

#[test]
fn another_selection_is_refused() {
    let mut other = request(1, UTF8, 50);
    other.selection = CLIPBOARD + 1;
    assert_eq!(answerer(1024, b"hi").answer(&other), Reply::Refuse);
}

#[test]
fn timestamp_answers_the_claim_time() {
    assert_eq!(
        answerer(1024, b"hi").answer(&request(1, TIMESTAMP, 50)),
        Reply::Integer {
            property: 50,
            value: 777
        }
    );
}

#[test]
fn a_request_with_no_property_uses_the_target_as_the_property() {
    let reply = answerer(1024, b"hi").answer(&request(1, UTF8, 0));
    assert!(
        matches!(reply, Reply::Bytes { property: UTF8, .. }),
        "{reply:?}"
    );
}

#[test]
fn a_value_above_one_property_starts_incr_and_one_at_the_limit_does_not() {
    let big = answerer(4, b"12345").answer(&request(1, UTF8, 50));
    assert_eq!(
        big,
        Reply::StartIncr {
            property: 50,
            kind: UTF8,
            total: 5
        }
    );
    let exact = answerer(5, b"12345").answer(&request(1, UTF8, 50));
    assert!(matches!(exact, Reply::Bytes { .. }), "{exact:?}");
}

fn sender(len: usize) -> IncrSender {
    IncrSender::new((0..len).map(|i| i as u8).collect::<Vec<u8>>().into(), 4)
}

fn drain(transfers: &mut Transfers, requestor: u32, property: u32) -> Vec<Vec<u8>> {
    let mut out = Vec::new();
    while let Some(chunk) = transfers.on_property_deleted(requestor, property) {
        out.push(chunk.data);
    }
    out
}

#[test]
fn two_concurrent_transfers_are_independent() {
    let mut transfers = Transfers::default();
    transfers.start(1, 50, UTF8, sender(8));
    transfers.start(2, 50, PLAIN, sender(4));
    let from_second = transfers.on_property_deleted(2, 50).expect("second");
    let from_first = transfers.on_property_deleted(1, 50).expect("first");
    assert_eq!(
        (from_second.kind, from_second.data),
        (PLAIN, vec![0, 1, 2, 3])
    );
    assert_eq!((from_first.kind, from_first.data), (UTF8, vec![0, 1, 2, 3]));
    assert_eq!(transfers.active.len(), 2);
}

#[test]
fn a_destroyed_requestor_ends_its_transfer_and_not_the_others() {
    let mut transfers = Transfers::default();
    transfers.start(1, 50, UTF8, sender(8));
    transfers.start(2, 50, UTF8, sender(8));
    transfers.drop_requestor(1);
    assert!(transfers.on_property_deleted(1, 50).is_none());
    assert!(transfers.on_property_deleted(2, 50).is_some());
}

#[test]
fn a_delete_on_a_property_with_no_transfer_is_ignored() {
    let mut transfers = Transfers::default();
    transfers.start(1, 50, UTF8, sender(8));
    assert!(transfers.on_property_deleted(1, 51).is_none());
    assert!(transfers.on_property_deleted(9, 50).is_none());
}

#[test]
fn the_ninth_concurrent_transfer_is_refused_and_the_bytes_are_shared() {
    let data: Arc<[u8]> = vec![7u8; 1024].into();
    let mut transfers = Transfers::default();
    for requestor in 0..MAX_TRANSFERS as u32 {
        let sender = IncrSender::new(Arc::clone(&data), 4);
        assert!(transfers.start(requestor, 50, UTF8, sender));
    }
    assert_eq!(Arc::strong_count(&data), MAX_TRANSFERS + 1);
    let refused = IncrSender::new(Arc::clone(&data), 4);
    assert!(!transfers.start(99, 50, UTF8, refused));
    assert_eq!(transfers.active.len(), MAX_TRANSFERS);
    assert_eq!(Arc::strong_count(&data), MAX_TRANSFERS + 1);
}

#[test]
fn a_restarted_transfer_replaces_its_own_and_does_not_count_twice() {
    let mut transfers = Transfers::default();
    for _ in 0..MAX_TRANSFERS + 3 {
        assert!(transfers.start(1, 50, UTF8, sender(8)));
    }
    assert_eq!(transfers.active.len(), 1);
}

#[test]
fn a_finished_transfer_frees_its_place() {
    let mut transfers = Transfers::default();
    for requestor in 0..MAX_TRANSFERS as u32 {
        assert!(transfers.start(requestor, 50, UTF8, sender(2)));
    }
    drain(&mut transfers, 0, 50);
    assert!(transfers.start(99, 50, UTF8, sender(2)));
}

#[test]
fn an_idle_transfer_is_dropped_and_a_fresh_one_is_kept() {
    let mut transfers = Transfers::default();
    transfers.start(1, 50, UTF8, sender(8));
    transfers.expire(TRANSFER_IDLE);
    assert_eq!(transfers.active.len(), 1);
    transfers.expire(Duration::ZERO);
    assert_eq!(transfers.active.len(), 0);
}
