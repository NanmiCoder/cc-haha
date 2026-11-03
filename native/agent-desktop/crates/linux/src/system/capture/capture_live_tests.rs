use agent_desktop_core::{ErrorCode, ScreenshotTarget};

use super::capture_live_support::*;
use crate::system::SharedBus;
use crate::system::capture::screenshot::{screenshot, screenshot_window_frame};
use crate::tree::live::live_launch::Launched;

fn window_at(x: i32, y: i32) -> Geometry {
    Geometry {
        x,
        y,
        width: 320,
        height: 200,
    }
}

#[test]
#[ignore = "needs a private X session; run through scripts/private-session.sh"]
fn grab_live_the_window_unit_follows_the_manager() {
    let _display = assert_private_display();
    let bus = SharedBus::default();
    let mut launched = Launched::new();
    let pid = paint(&mut launched, "adcap-unit", "#ff0000", &window_at(200, 150));
    let window = wait_for_listed(&bus, pid);
    let framed = screenshot_window_frame(&bus, &window, deadline(20_000));
    let whole = screenshot(
        &bus,
        ScreenshotTarget::ExactWindow(window),
        deadline(20_000),
    );
    println!(
        "grab_live compositing={} frame={:?} screenshot={}",
        compositing(),
        framed.as_ref().map(|image| (image.width, image.height)),
        whole.is_ok()
    );
    assert!(whole.is_ok(), "screenshot always returns the frame image");
    if compositing() {
        let error = framed.expect_err("a GTK3 window passes neither unit check under mutter");
        assert_eq!(error.code, ErrorCode::ActionFailed);
    } else {
        framed.expect("the GTK3 frame passes the unit check on openbox");
    }
}

#[test]
#[ignore = "needs a private X session; run through scripts/private-session.sh"]
fn grab_live_a_window_partly_off_screen_reports_off_screen() {
    let _display = assert_private_display();
    let bus = SharedBus::default();
    let mut launched = Launched::new();
    let pid = paint(
        &mut launched,
        "adcap-edge",
        "#ff0000",
        &window_at(1200, 700),
    );
    let window = wait_for_listed(&bus, pid);
    let window = place_partly_off_screen(&bus, &window, &window_at(1200, 700));
    let outcome = screenshot(
        &bus,
        ScreenshotTarget::ExactWindow(window),
        deadline(20_000),
    );
    println!(
        "grab_live off-screen compositing={} outcome={:?}",
        compositing(),
        outcome.as_ref().map(|image| (image.width, image.height))
    );
    let error = outcome.expect_err("a window partly outside the screen is refused");
    assert_eq!(reason(&error), "off_screen");
}

#[test]
#[ignore = "needs a private X session; run through scripts/private-session.sh"]
fn grab_live_the_capture_permission_follows_the_session() {
    use agent_desktop_core::Deadline;

    use crate::system::display::display_env::DisplayEnv;
    use crate::system::display::display_probe::SocketProbe;
    use crate::system::display::display_server::detect;
    use crate::system::display::route::resolve;
    use crate::system::permissions::{CaptureAvailability, capture_availability};
    use crate::system::x11::capture::grab::DisplayGrabber;

    let _display = assert_private_display();
    let deadline = Deadline::after(10_000).expect("a deadline builds");
    let x11 = detect(&DisplayEnv::from_process(), &SocketProbe);
    let reachable = capture_availability(resolve(x11), &DisplayGrabber, deadline);
    assert!(matches!(reachable, CaptureAvailability::Reachable));

    let runtime = std::env::var("XDG_RUNTIME_DIR").expect("a runtime directory");
    let socket = format!("{runtime}/adcap-wayland");
    let _ = std::fs::remove_file(&socket);
    let _listener = std::os::unix::net::UnixListener::bind(&socket).expect("a socket binds");
    let mut env = DisplayEnv::from_process();
    env.wayland = Some(socket);
    let wayland = detect(&env, &SocketProbe);
    let unknown = capture_availability(resolve(wayland), &DisplayGrabber, deadline);
    assert!(matches!(unknown, CaptureAvailability::Unknown));
}

#[test]
#[ignore = "needs a private X session; run through scripts/private-session.sh"]
fn grab_live_a_stopped_window_is_app_unresponsive() {
    use agent_desktop_core::ErrorCode;

    use crate::system::capture::capture_env::CaptureEnv;
    use crate::system::capture::png_encode::encode_png;
    use crate::system::capture::window::capture;
    use crate::system::capture::window_context::real_decode;
    use crate::system::x11::DisplayReader;
    use crate::system::x11::capture::grab::DisplayGrabber;

    let _display = assert_private_display();
    let bus = SharedBus::default();
    let mut launched = Launched::new();
    let pid = paint(
        &mut launched,
        "adcap-frozen",
        "#ff0000",
        &window_at(200, 150),
    );
    let window = wait_for_listed(&bus, pid);
    let xid = x_window_id("adcap-frozen");
    stop(pid);
    let lookup = FixedLookup { xid };
    let env = CaptureEnv {
        grabber: &DisplayGrabber,
        stacking: &DisplayReader,
        lookup: &lookup,
        decode: real_decode,
        encode: encode_png,
        stopped: crate::system::process::proc_stat::is_stopped,
    };
    let started = std::time::Instant::now();
    let outcome = capture(&env, &window, false, deadline(20_000));
    println!(
        "grab_live frozen compositing={} after={:?} outcome={:?}",
        compositing(),
        started.elapsed(),
        outcome.as_ref().map(|image| (image.width, image.height))
    );
    assert!(started.elapsed() < std::time::Duration::from_secs(15));
    let error = outcome.expect_err("a stopped process is not captured");
    assert_eq!(error.code, ErrorCode::AppUnresponsive);
}
