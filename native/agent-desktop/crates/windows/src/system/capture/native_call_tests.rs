use std::sync::atomic::AtomicBool;
use std::sync::mpsc::sync_channel;
use std::time::Duration;

use agent_desktop_core::{Deadline, DeliverySemantics};

use super::run;

#[test]
fn timed_out_capture_returns_and_keeps_one_worker_slot_until_native_call_finishes() {
    static ACTIVE: AtomicBool = AtomicBool::new(false);
    let (release, wait) = sync_channel::<()>(1);
    let deadline = Deadline::after(10).expect("short deadline");

    let error = run(
        deadline,
        &ACTIVE,
        "test-capture",
        DeliverySemantics::not_delivered(),
        move || {
            let _ = wait.recv();
            Ok::<_, agent_desktop_core::AdapterError>(())
        },
    )
    .expect_err("the parked worker must not block the caller past its deadline");
    assert_eq!(error.code, agent_desktop_core::ErrorCode::Timeout);
    assert_eq!(error.disposition, DeliverySemantics::not_delivered());

    let second = run(
        Deadline::after(100).expect("second deadline"),
        &ACTIVE,
        "test-capture",
        DeliverySemantics::not_delivered(),
        || Ok::<_, agent_desktop_core::AdapterError>(()),
    )
    .expect_err("a parked capture must not permit another unbounded worker");
    assert_eq!(second.code, agent_desktop_core::ErrorCode::AppUnresponsive);
    release.send(()).expect("release worker");

    let end = std::time::Instant::now() + Duration::from_secs(1);
    while ACTIVE.load(std::sync::atomic::Ordering::Acquire) && std::time::Instant::now() < end {
        std::thread::yield_now();
    }
    assert!(!ACTIVE.load(std::sync::atomic::Ordering::Acquire));
    run(
        Deadline::after(100).expect("third deadline"),
        &ACTIVE,
        "test-capture",
        DeliverySemantics::not_delivered(),
        || Ok::<_, agent_desktop_core::AdapterError>(()),
    )
    .expect("the slot should recover when the parked call returns");
}
