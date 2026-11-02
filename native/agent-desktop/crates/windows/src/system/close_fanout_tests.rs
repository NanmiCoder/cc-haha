use super::*;
use agent_desktop_core::DeliveryDisposition;

fn unusable_window() -> AdapterError {
    AdapterError::new(ErrorCode::ActionFailed, "PostMessageW(WM_CLOSE) failed")
}

/// One window's refusal must not cancel delivery to the others: the window
/// that owns an app's shutdown can be anywhere in the list, including after
/// a sibling that already refused or one that tore itself down in response
/// to an earlier post in the same fan-out.
#[test]
fn a_failing_window_does_not_cancel_close_delivery_to_the_others() {
    let mut attempted = Vec::new();
    let result = super::broadcast_close(&[1, 2, 3], Deadline::after(1_000).expect("deadline"), {
        let attempted = &mut attempted;
        move |hwnd| {
            attempted.push(hwnd);
            if hwnd == 1 {
                Err(unusable_window())
            } else {
                Ok(true)
            }
        }
    });

    assert!(
        result.expect("a delivered sibling makes the fan-out a success"),
        "at least one successful post must report delivered"
    );
    assert_eq!(
        attempted,
        vec![1, 2, 3],
        "every owned window is attempted even after one fails"
    );
}

/// The honest converse: when nothing accepted the request, the failure is
/// reported rather than swallowed into a silent success.
#[test]
fn a_fan_out_that_delivers_nothing_reports_the_failure() {
    let error = super::broadcast_close(&[1, 2], Deadline::after(1_000).expect("deadline"), |_| {
        Err(unusable_window())
    })
    .expect_err("no window accepted the close");

    assert_eq!(error.code, ErrorCode::ActionFailed);
    assert_eq!(
        error.disposition.delivery(),
        DeliveryDisposition::NotDelivered,
        "nothing was delivered, so the caller may safely retry"
    );
}

/// A window skipped on ownership grounds is not itself a fan-out failure, but
/// it is not a delivered close either: `broadcast_close` reports an all-skip
/// fan-out as nothing delivered so the caller applies the same liveness check
/// it uses for a process with no windows at all, instead of assuming the skip
/// means the OS accepted the request.
#[test]
fn skipped_windows_alone_report_nothing_delivered() {
    let delivered =
        super::broadcast_close(&[1, 2], Deadline::after(1_000).expect("deadline"), |_| {
            Ok(false)
        })
        .expect("skips alone are not a fan-out failure");

    assert!(
        !delivered,
        "an all-skip fan-out must report nothing delivered, not a false success"
    );
}
