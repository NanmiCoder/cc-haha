use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc::channel;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use super::*;

fn deadline(ms: u64) -> Deadline {
    Deadline::from_duration(Duration::from_millis(ms)).expect("a deadline builds")
}

#[test]
fn the_send_runs_once_on_the_calling_thread_and_the_prepare_on_another() {
    let caller = std::thread::current().id();
    let prepared_on = Arc::new(Mutex::new(None));
    let sink = Arc::clone(&prepared_on);
    let outcome = deliver(
        deadline(2_000),
        move |_| {
            *sink.lock().expect("the lock is not poisoned") = Some(std::thread::current().id());
            Ok(Ok(7_u32))
        },
        |prepared| {
            assert_eq!(prepared, 7);
            assert_eq!(std::thread::current().id(), caller);
            Ok(())
        },
    );
    assert_eq!(outcome, Ok(()));
    let worker = prepared_on
        .lock()
        .expect("the lock is not poisoned")
        .expect("the prepare ran");
    assert_ne!(worker, caller);
}

#[test]
fn a_preparation_that_outlives_the_deadline_is_timed_out_and_never_sent() {
    let sent = Arc::new(AtomicBool::new(false));
    let (finished, done) = channel();
    let flag = Arc::clone(&sent);
    let outcome = deliver(
        deadline(50),
        move |_| {
            std::thread::sleep(Duration::from_millis(300));
            let _ = finished.send(());
            Ok(Ok(()))
        },
        move |()| {
            flag.store(true, Ordering::SeqCst);
            Ok(())
        },
    );
    assert_eq!(outcome, Err(ControlError::TimedOut));
    done.recv_timeout(Duration::from_secs(2))
        .expect("the worker finished");
    assert!(!sent.load(Ordering::SeqCst));
}

#[test]
fn a_destroyed_window_is_bad_window_and_nothing_is_sent() {
    let sent = Arc::new(AtomicBool::new(false));
    let flag = Arc::clone(&sent);
    let outcome = deliver(
        deadline(2_000),
        |_| Ok(Err::<(), _>(ControlError::BadWindow)),
        move |()| {
            flag.store(true, Ordering::SeqCst);
            Ok(())
        },
    );
    assert_eq!(outcome, Err(ControlError::BadWindow));
    assert!(!sent.load(Ordering::SeqCst));
}

#[test]
fn no_display_is_reported_as_no_display() {
    let outcome = deliver(
        deadline(2_000),
        |_| Err::<Result<(), ControlError>, _>(ActivateError::NoDisplay),
        |()| Ok(()),
    );
    assert_eq!(outcome, Err(ControlError::NoDisplay));
}

#[test]
fn a_failed_preparation_inside_the_deadline_is_a_failed_send() {
    let outcome = deliver(
        deadline(2_000),
        |_| Err::<Result<(), ControlError>, _>(ActivateError::SendFailed),
        |()| Ok(()),
    );
    assert_eq!(outcome, Err(ControlError::SendFailed));
}

#[test]
fn an_error_the_server_raised_names_a_destroyed_window() {
    use x11rb::errors::ConnectionError;
    use x11rb::x11_utils::X11Error;

    let raised = X11Error {
        error_kind: x11rb::protocol::ErrorKind::Window,
        error_code: 3,
        sequence: 1,
        bad_value: 0x40_0003,
        minor_opcode: 0,
        major_opcode: 3,
        extension_name: None,
        request_name: None,
    };
    assert_eq!(
        classify(ReplyError::X11Error(raised)),
        ControlError::BadWindow
    );
    assert_eq!(
        classify(ReplyError::ConnectionError(ConnectionError::UnknownError)),
        ControlError::SendFailed
    );
}

#[test]
fn a_send_that_never_confirms_is_abandoned_at_the_deadline_as_uncertain() {
    let started = std::time::Instant::now();
    let outcome = within_deadline(deadline(100), (), |()| {
        std::thread::sleep(Duration::from_secs(2));
        Ok(())
    });
    assert_eq!(outcome, Err(ControlError::SendFailed));
    assert!(started.elapsed() < Duration::from_millis(1_000));
}

#[test]
fn nothing_is_written_once_the_deadline_has_passed() {
    let ran = Arc::new(AtomicBool::new(false));
    let seen = Arc::clone(&ran);
    let expired = Deadline::from_duration(Duration::from_millis(1)).expect("a deadline builds");
    std::thread::sleep(Duration::from_millis(20));
    let outcome = within_deadline(expired, (), move |()| {
        seen.store(true, Ordering::SeqCst);
        Ok(())
    });
    assert!(matches!(
        outcome,
        Err(ControlError::TimedOut | ControlError::SendFailed)
    ));
    std::thread::sleep(Duration::from_millis(50));
    assert!(!ran.load(Ordering::SeqCst));
}
