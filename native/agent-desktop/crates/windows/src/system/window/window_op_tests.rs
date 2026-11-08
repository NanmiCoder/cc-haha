use super::*;
use agent_desktop_core::{DeliveryDisposition, InteractionLease};

#[test]
fn geometry_rejects_non_finite_and_extreme_values() {
    assert!(validate_size(f64::NAN, 100.0).is_err());
    assert!(validate_size(100.0, f64::INFINITY).is_err());
    assert!(validate_size(0.0, 100.0).is_err());
    assert!(validate_size(-10.0, 100.0).is_err());
    assert!(validate_size(1_000_001.0, 100.0).is_err());
    assert!(validate_position(f64::NEG_INFINITY, 0.0).is_err());
    assert!(validate_position(1_000_001.0, 0.0).is_err());
}

#[test]
fn geometry_accepts_negative_screen_coordinates() {
    assert!(validate_position(-1920.0, 0.0).is_ok());
    assert!(validate_position(0.0, -1080.0).is_ok());
    assert!(validate_size(1920.0, 1080.0).is_ok());
}

#[cfg(target_os = "windows")]
use crate::system::fixture::test_time::deadline;

#[cfg(target_os = "windows")]
fn lease() -> InteractionLease {
    InteractionLease::guarded(deadline(10_000), ()).expect("lease")
}

#[cfg(target_os = "windows")]
fn staged_fixture() -> (crate::tree::fixture::LocalFixture, WindowInfo) {
    crate::tree::fixture::ensure_test_apartment();
    let (left, top) = crate::tree::fixture::fixture_window::on_screen_origin();
    let fixture =
        crate::tree::fixture::LocalFixture::create_at(left, top).expect("on-screen fixture");
    let info = window_info_for(fixture.handle());
    (fixture, info)
}

#[cfg(target_os = "windows")]
fn window_info_for(handle: isize) -> WindowInfo {
    crate::system::fixture::live_identity::window_info_for_current_process(handle)
}

#[cfg(target_os = "windows")]
fn current_rect(handle: isize) -> (i32, i32, i32, i32) {
    window_rect(handle as super::super::window_enum::WindowHandle).expect("rect")
}

#[cfg(target_os = "windows")]
fn current_show_cmd(handle: isize) -> u32 {
    placement_show_cmd(handle as super::super::window_enum::WindowHandle).expect("placement")
}

#[cfg(target_os = "windows")]
#[test]
fn resize_is_confirmed_by_get_window_rect_within_tolerance() {
    let _stage = crate::tree::fixture::fixture_window::on_screen_stage();
    let (fixture, info) = staged_fixture();
    let (left, top, width, height) = current_rect(fixture.handle());
    let target_w = width + 24;
    let target_h = height + 16;
    window_op_impl(
        &info,
        WindowOp::Resize {
            width: f64::from(target_w),
            height: f64::from(target_h),
        },
        lease().deadline(),
    )
    .expect("resize");
    let (after_left, after_top, after_w, after_h) = current_rect(fixture.handle());
    assert!(within_tolerance(after_w, target_w));
    assert!(within_tolerance(after_h, target_h));
    assert!(within_tolerance(after_left, left));
    assert!(within_tolerance(after_top, top));
}

#[cfg(target_os = "windows")]
#[test]
fn move_is_confirmed_by_get_window_rect_within_tolerance() {
    let _stage = crate::tree::fixture::fixture_window::on_screen_stage();
    let (fixture, info) = staged_fixture();
    let (left, top, width, height) = current_rect(fixture.handle());
    let target_x = left + 32;
    let target_y = top + 24;
    window_op_impl(
        &info,
        WindowOp::Move {
            x: f64::from(target_x),
            y: f64::from(target_y),
        },
        lease().deadline(),
    )
    .expect("move");
    let (after_left, after_top, after_w, after_h) = current_rect(fixture.handle());
    assert!(within_tolerance(after_left, target_x));
    assert!(within_tolerance(after_top, target_y));
    assert!(within_tolerance(after_w, width));
    assert!(within_tolerance(after_h, height));
}

#[cfg(target_os = "windows")]
#[test]
fn minimize_is_confirmed_by_show_cmd_not_uia_geometry() {
    use windows_sys::Win32::UI::WindowsAndMessaging::SW_SHOWMINIMIZED;

    let _stage = crate::tree::fixture::fixture_window::on_screen_stage();
    let (fixture, info) = staged_fixture();
    window_op_impl(&info, WindowOp::Minimize, lease().deadline()).expect("minimize");
    assert_eq!(current_show_cmd(fixture.handle()), SW_SHOWMINIMIZED as u32);
}

#[cfg(target_os = "windows")]
#[test]
fn maximize_is_confirmed_by_show_cmd() {
    use windows_sys::Win32::UI::WindowsAndMessaging::SW_SHOWMAXIMIZED;

    let _stage = crate::tree::fixture::fixture_window::on_screen_stage();
    let (fixture, info) = staged_fixture();
    window_op_impl(&info, WindowOp::Maximize, lease().deadline()).expect("maximize");
    assert_eq!(current_show_cmd(fixture.handle()), SW_SHOWMAXIMIZED as u32);
}

#[cfg(target_os = "windows")]
#[test]
fn restore_is_confirmed_by_show_cmd() {
    use windows_sys::Win32::UI::WindowsAndMessaging::SW_SHOWNORMAL;

    let _stage = crate::tree::fixture::fixture_window::on_screen_stage();
    let (fixture, info) = staged_fixture();
    window_op_impl(&info, WindowOp::Minimize, lease().deadline()).expect("minimize");
    window_op_impl(&info, WindowOp::Restore, lease().deadline()).expect("restore");
    assert_eq!(current_show_cmd(fixture.handle()), SW_SHOWNORMAL as u32);
}

#[cfg(target_os = "windows")]
#[test]
fn non_finite_geometry_is_invalid_args_before_native_write() {
    let _stage = crate::tree::fixture::fixture_window::on_screen_stage();
    let (fixture, info) = staged_fixture();
    let before = current_rect(fixture.handle());
    let error = window_op_impl(
        &info,
        WindowOp::Resize {
            width: f64::NAN,
            height: 100.0,
        },
        lease().deadline(),
    )
    .expect_err("nan refused");
    assert_eq!(error.code, ErrorCode::InvalidArgs);
    assert_eq!(
        error.disposition.delivery(),
        DeliveryDisposition::NotDelivered
    );
    let after = current_rect(fixture.handle());
    assert_eq!(after, before);
}

#[cfg(target_os = "windows")]
#[test]
fn negative_move_coordinates_are_accepted_when_finite() {
    let _stage = crate::tree::fixture::fixture_window::on_screen_stage();
    let (fixture, info) = staged_fixture();
    let (_, top, _, _) = current_rect(fixture.handle());
    let (virtual_left, _, _, _) = crate::tree::hit_test::virtual_screen_metrics();
    let target_x = virtual_left - 48;
    let target_y = top;
    assert!(
        target_x < 0,
        "the target must be a negative screen coordinate or this test proves nothing \
         about negative moves"
    );
    window_op_impl(
        &info,
        WindowOp::Move {
            x: f64::from(target_x),
            y: f64::from(target_y),
        },
        lease().deadline(),
    )
    .expect("negative-capable move");
    let (after_left, after_top, _, _) = current_rect(fixture.handle());
    assert!(within_tolerance(after_left, target_x));
    assert!(within_tolerance(after_top, target_y));
}

#[cfg(target_os = "windows")]
#[test]
fn recycled_hwnd_ownership_mismatch_fails_closed_not_delivered() {
    let _stage = crate::tree::fixture::fixture_window::on_screen_stage();
    let (fixture, mut info) = staged_fixture();
    let before = current_rect(fixture.handle());
    info.process_instance = Some("windows-proc-v1:0:0".into());
    let error = window_op_impl(
        &info,
        WindowOp::Resize {
            width: f64::from(before.2 + 40),
            height: f64::from(before.3 + 40),
        },
        lease().deadline(),
    )
    .expect_err("stale generation refused");
    assert_eq!(error.code, ErrorCode::WindowNotFound);
    assert_eq!(
        error.disposition.delivery(),
        DeliveryDisposition::NotDelivered
    );
    let after = current_rect(fixture.handle());
    assert_eq!(after, before);
}

#[cfg(target_os = "windows")]
#[test]
fn window_op_refuses_an_expired_deadline_before_any_write() {
    let _stage = crate::tree::fixture::fixture_window::on_screen_stage();
    let (fixture, info) = staged_fixture();
    let before = current_rect(fixture.handle());
    let expired = Deadline::after(1).expect("deadline");
    std::thread::sleep(std::time::Duration::from_millis(5));
    let error = window_op_impl(&info, WindowOp::Minimize, expired).expect_err("timeout");
    assert_eq!(error.code, ErrorCode::Timeout);
    assert_eq!(
        error.disposition.delivery(),
        DeliveryDisposition::NotDelivered
    );
    let after = current_rect(fixture.handle());
    assert_eq!(after, before);
}

/// A window whose thread never dispatches blocks `ShowWindow`/`SetWindowPos`
/// inside the OS call, so the write must be refused before it is issued
/// rather than hanging the command behind a deadline that cannot interrupt it.
#[cfg(target_os = "windows")]
#[test]
fn a_window_that_never_pumps_is_refused_instead_of_blocking_the_write() {
    let stalled = crate::tree::fixture::StalledFixture::create().expect("stalled");
    let info = window_info_for(stalled.handle());
    let lease =
        InteractionLease::guarded(Deadline::after(10_000).expect("deadline"), ()).expect("lease");

    let error = window_op_impl(&info, WindowOp::Minimize, lease.deadline())
        .expect_err("a non-pumping target must be refused, not written to");

    assert_eq!(error.code, ErrorCode::AppUnresponsive);
    assert_eq!(
        error.disposition.delivery(),
        DeliveryDisposition::NotDelivered,
        "the write never issued, so the caller may safely retry"
    );
}

/// A window minimized while maximized restores to maximized, so the restore
/// verb must accept that placement. Demanding an exact normal placement would
/// report this ordinary sequence as a failure the caller cannot safely retry.
#[cfg(target_os = "windows")]
#[test]
fn restore_from_a_maximized_minimize_is_confirmed_not_reported_failed() {
    let _stage = crate::tree::fixture::fixture_window::on_screen_stage();
    use windows_sys::Win32::UI::WindowsAndMessaging::SW_SHOWMAXIMIZED;

    let (fixture, info) = staged_fixture();
    window_op_impl(&info, WindowOp::Maximize, lease().deadline()).expect("maximize");
    window_op_impl(&info, WindowOp::Minimize, lease().deadline()).expect("minimize from maximized");
    window_op_impl(&info, WindowOp::Restore, lease().deadline())
        .expect("restore of a maximized-then-minimized window is a success");
    assert_eq!(
        current_show_cmd(fixture.handle()),
        SW_SHOWMAXIMIZED as u32,
        "the window returns to maximized, which is what restore means here"
    );
}

#[cfg(target_os = "windows")]
#[test]
fn position_write_stays_bounded_when_target_hangs_after_the_last_probe() {
    let fixture = crate::tree::fixture::fixture_hung_after_probe::HungAfterProbeFixture::create()
        .expect("hostile fixture");
    let info = window_info_for(fixture.handle());
    fixture
        .hang_after_probe(2)
        .expect("second probe arms the hang");
    let started = std::time::Instant::now();

    let result = window_op_impl(&info, WindowOp::Move { x: 130.0, y: 150.0 }, deadline(200));

    assert!(
        fixture.did_hang(),
        "target must hang after answering the probe"
    );
    assert!(started.elapsed() < std::time::Duration::from_secs(1));
    let error = result.expect_err("the queued write remains unconfirmed");
    assert_eq!(error.code, ErrorCode::Timeout);
    assert_eq!(error.disposition, DeliverySemantics::delivered_unverified());
}

#[cfg(target_os = "windows")]
#[test]
fn show_write_stays_bounded_when_target_hangs_after_the_last_probe() {
    let fixture = crate::tree::fixture::fixture_hung_after_probe::HungAfterProbeFixture::create()
        .expect("hostile fixture");
    let info = window_info_for(fixture.handle());
    fixture
        .hang_after_probe(2)
        .expect("second probe arms the hang");
    let started = std::time::Instant::now();

    let result = window_op_impl(&info, WindowOp::Minimize, deadline(200));

    assert!(
        fixture.did_hang(),
        "target must hang after answering the probe"
    );
    assert!(started.elapsed() < std::time::Duration::from_secs(1));
    let error = result.expect_err("the queued write remains unconfirmed");
    assert_eq!(error.code, ErrorCode::Timeout);
    assert_eq!(error.disposition, DeliverySemantics::delivered_unverified());
}

#[cfg(target_os = "windows")]
#[test]
fn show_window_async_reports_invalid_handle_but_accepts_a_live_window() {
    use windows_sys::Win32::UI::WindowsAndMessaging::{SW_RESTORE, ShowWindowAsync};

    let _stage = crate::tree::fixture::fixture_window::on_screen_stage();
    let (fixture, _) = staged_fixture();
    assert_eq!(
        unsafe { ShowWindowAsync(std::ptr::null_mut(), SW_RESTORE) },
        0,
        "an invalid HWND must fail to queue a show operation"
    );
    assert_ne!(
        unsafe { ShowWindowAsync(fixture.handle() as _, SW_RESTORE) },
        0,
        "a live HWND must report that the async show was started"
    );
}

#[cfg(target_os = "windows")]
#[test]
fn queued_window_changes_survive_a_temporary_message_pump_delay() {
    for op in [WindowOp::Move { x: 130.0, y: 150.0 }, WindowOp::Minimize] {
        let fixture =
            crate::tree::fixture::fixture_hung_after_probe::HungAfterProbeFixture::create()
                .expect("delayed fixture");
        let info = window_info_for(fixture.handle());
        fixture
            .hang_after_probe(2)
            .expect("arm pause after admission");
        fixture.resume_after(300);
        window_op_impl(&info, op.clone(), deadline(2_000)).expect("queued operation completes");
        assert!(fixture.did_hang());
        match op {
            WindowOp::Move { .. } => {
                let rect = current_rect(fixture.handle());
                assert!(within_tolerance(rect.0, 130));
                assert!(within_tolerance(rect.1, 150));
            }
            WindowOp::Minimize => assert!(verb_is_satisfied(
                ShowVerb::Minimize,
                current_show_cmd(fixture.handle())
            )),
            _ => unreachable!(),
        }
    }
}
