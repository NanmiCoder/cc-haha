use super::{WorkerTicket, ensure_no_outstanding_worker, refusal_for};
use agent_desktop_core::{DeliveryDisposition, ErrorCode};
use std::sync::atomic::{AtomicUsize, Ordering};

/// These cases arm a counter of their own rather than the process-wide one.
/// Arming the real counter would refuse the live clipboard tests running
/// beside them - a race the guard would have caused rather than caught, and
/// exactly the kind of test that fails for a reason unrelated to its claim.
static TEST_COUNTER: AtomicUsize = AtomicUsize::new(0);

/// The ordinary path is unaffected, which is what keeps the refusal below a
/// claim about a real condition rather than a guard that always fires.
#[test]
fn nothing_outstanding_lets_a_clipboard_operation_proceed() {
    assert!(refusal_for(0).is_none());
    assert!(ensure_no_outstanding_worker().is_ok());
}

/// A worker that has not returned means the next operation in this process is
/// refused rather than left to contend with a read nothing can reclaim.
#[test]
fn an_outstanding_worker_refuses_the_next_clipboard_operation() {
    let error = refusal_for(1).expect("an outstanding worker refuses");

    assert_eq!(error.code, ErrorCode::AppUnresponsive);
    assert_eq!(
        error.disposition.delivery(),
        DeliveryDisposition::NotDelivered
    );
    assert!(
        error
            .platform_detail
            .as_deref()
            .is_some_and(|detail| detail.contains('1')),
        "the refusal names how many workers are outstanding"
    );
    assert!(
        error.suggestion.is_some(),
        "the refusal says what clears it, since a caller cannot cancel the parked read"
    );
}

/// A worker that returns releases its ticket, so the refusal is transient
/// rather than a one-way latch that would wedge the process.
#[test]
fn a_worker_that_returns_releases_its_ticket() {
    {
        let _ticket = WorkerTicket::arm_on(&TEST_COUNTER);
        assert_eq!(TEST_COUNTER.load(Ordering::SeqCst), 1);
    }

    assert_eq!(TEST_COUNTER.load(Ordering::SeqCst), 0);
}

/// A worker that unwinds releases too, because the ticket drops on the
/// unwinding path - a panicking read must not wedge every later one.
#[test]
fn a_worker_that_panics_releases_its_ticket() {
    static PANIC_COUNTER: AtomicUsize = AtomicUsize::new(0);

    let panicked = std::panic::catch_unwind(|| {
        let _ticket = WorkerTicket::arm_on(&PANIC_COUNTER);
        panic!("the read failed inside the worker");
    });

    assert!(panicked.is_err());
    assert_eq!(PANIC_COUNTER.load(Ordering::SeqCst), 0);
}

/// Every clipboard entry point must consult the guard, and a pure test of the
/// refusal cannot see whether they do. Arming the real counter to check would
/// refuse the live clipboard tests beside it, so the wiring is asserted from
/// the source the way this crate already asserts the absent ACL symbols.
#[test]
fn every_clipboard_entry_point_consults_the_guard() {
    let source = include_str!("mod.rs");
    let guard = "clipboard_worker_state::ensure_no_outstanding_worker()";

    for entry in [
        "pub(crate) fn get_clipboard_content(",
        "pub(crate) fn set_content(",
        "pub(crate) fn clear(",
        "pub(crate) fn read_format_bytes(",
    ] {
        let start = source
            .find(entry)
            .unwrap_or_else(|| panic!("{entry} still exists in clipboard.rs"));
        let body = &source[start..];
        let end = body
            .find(
                "
}",
            )
            .unwrap_or(body.len());
        assert!(
            body[..end].contains(guard),
            "{entry} must refuse while a previous read's worker still holds the clipboard open"
        );
    }
}

/// The ticket is armed on the caller's thread before the worker is spawned, so
/// a read whose deadline expires before the thread even starts still leaves the
/// guard armed - and it is released inside the worker before the result is
/// sent, so a completed read does not refuse the operation that follows it.
/// Getting either half wrong made the live clipboard tests refuse each other.
#[test]
fn the_ticket_is_armed_before_the_spawn_and_released_before_the_send() {
    let source = include_str!("mod.rs");
    let function = source
        .find("fn read_format_bytes_on_worker(")
        .expect("read_format_bytes_on_worker still exists in clipboard.rs");
    let body = &source[function..];
    let body = &body[..body.find("\n}").unwrap_or(body.len())];
    let arm = body
        .find("let ticket = crate::input::clipboard::clipboard_worker_state::WorkerTicket::arm();")
        .expect("the ticket is armed in read_format_bytes_on_worker");
    let spawn = body
        .find("thread::spawn(")
        .expect("read_format_bytes_on_worker spawns the worker");
    let release = body
        .find("let _ticket = ticket;")
        .expect("the ticket moves into the worker");
    let send = body
        .find("let _ = sender.send(result);")
        .expect("the worker sends its result");

    assert!(arm < spawn, "the ticket is armed before the spawn");
    assert!(
        release < send,
        "the ticket is released before the result is sent, or the next operation is \n             refused while its caller already holds the value"
    );
}
