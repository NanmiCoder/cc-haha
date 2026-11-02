use std::collections::BTreeSet;
use std::time::{Duration, Instant};

use agent_desktop_core::{AdapterError, Deadline, ErrorCode, ScreenshotTarget};

use super::wayland_portal::capture_wayland;
use super::wayland_portal_live_monitors::{allow_screenshots, capture_target, set_first_scale};
use super::wayland_portal_live_support::{
    BLUE, BUS_DAEMON, DIALOG_SHOWN, Endpoint, FRONTEND, KEY_RETURN, KEY_TAB, Keys, World, boot,
    boot_with, bus_call, runtime_dir, stored_screenshot_grants,
};
use crate::system::bus::bus_deadline::within;
use crate::system::bus::session_bus::SessionBus;

#[path = "portal_layout_live_tests.rs"]
mod layout;

fn home_screenshots() -> BTreeSet<String> {
    let home = runtime_dir().join("portal-home");
    std::fs::read_dir(home)
        .map(|entries| {
            entries
                .flatten()
                .filter_map(|entry| entry.file_name().into_string().ok())
                .filter(|name| name.starts_with("Screenshot") && name.ends_with(".png"))
                .collect()
        })
        .unwrap_or_default()
}

fn capture_while(
    world: &World,
    ms: u64,
    answer: impl FnOnce(&Keys),
) -> Result<agent_desktop_core::ImageBuffer, agent_desktop_core::AdapterError> {
    let deadline = Deadline::after(ms).expect("a deadline");
    let worker =
        std::thread::spawn(move || capture_wayland(&ScreenshotTarget::FullScreen, deadline));
    std::thread::sleep(DIALOG_SHOWN);
    answer(&world.keys);
    worker.join().expect("the capture thread ends")
}

fn blue_pixels(png_bytes: &[u8]) -> (u32, u32, usize) {
    let mut decoder = png::Decoder::new(std::io::Cursor::new(png_bytes));
    decoder.set_transformations(png::Transformations::EXPAND);
    let mut reader = decoder.read_info().expect("a PNG header");
    let mut buffer = vec![0; reader.output_buffer_size().expect("a size")];
    let info = reader.next_frame(&mut buffer).expect("a frame");
    let channels = info.color_type.samples();
    let count = buffer[..info.buffer_size()]
        .chunks_exact(channels)
        .filter(|pixel| pixel[..3] == BLUE)
        .count();
    (info.width, info.height, count)
}

#[test]
#[ignore = "boots a private headless gnome-shell and its portal; run inside scripts/private-session.sh"]
fn no_answer_is_a_timeout_that_names_the_dialog_and_leaves_no_file() {
    let world = boot();
    let before = home_screenshots();
    let started = Instant::now();
    let silent = capture_while(&world, 9_000, |_| {}).expect_err("no answer is a timeout");
    println!(
        "portal_live silent {:?} after {:?}",
        silent.code,
        started.elapsed()
    );
    assert_eq!(silent.code, ErrorCode::Timeout);
    assert!(
        silent
            .suggestion
            .as_deref()
            .is_some_and(|text| text.contains("dialog"))
    );
    assert!(started.elapsed() < Duration::from_secs(20));
    assert_eq!(home_screenshots(), before);
}

#[test]
#[ignore = "boots a private headless gnome-shell and its portal; run inside scripts/private-session.sh"]
fn allow_gives_the_desktop_and_leaves_no_file() {
    let world = boot();
    let before = home_screenshots();
    let allowed = capture_while(&world, 25_000, |keys| {
        keys.press(KEY_TAB);
        std::thread::sleep(Duration::from_millis(400));
        keys.press(KEY_RETURN);
    })
    .expect("the desktop is captured after Allow");
    let (width, height, blue) = blue_pixels(&allowed.data);
    println!("portal_live allowed {width}x{height} blue={blue}");
    assert_eq!((allowed.width, allowed.height), (1280, 800));
    assert_eq!((width, height), (1280, 800));
    assert!(
        blue >= 100_000,
        "the painter window is in the image: {blue}"
    );
    assert_eq!(home_screenshots(), before, "the portal's file is removed");
}

#[test]
#[ignore = "boots a private headless gnome-shell and its portal; run inside scripts/private-session.sh"]
fn deny_is_permission_denied_and_leaves_no_file() {
    let world = boot();
    let before = home_screenshots();
    let denied = capture_while(&world, 25_000, |keys| keys.press(KEY_RETURN))
        .map(|image| image.data.len())
        .expect_err("Deny is a refusal");
    println!("portal_live denied {:?}", denied.code);
    assert_eq!(denied.code, ErrorCode::PermDenied);
    assert_eq!(home_screenshots(), before);
}

fn quick_capture() -> (
    Result<agent_desktop_core::ImageBuffer, agent_desktop_core::AdapterError>,
    Duration,
) {
    let started = Instant::now();
    let deadline = Deadline::after(15_000).expect("a deadline");
    let outcome = capture_wayland(&ScreenshotTarget::FullScreen, deadline);
    (outcome, started.elapsed())
}

#[test]
#[ignore = "boots a private headless gnome-shell and its portal; run inside scripts/private-session.sh"]
fn one_allow_is_remembered_for_the_host_process_and_later_calls_show_no_dialog() {
    let world = boot();
    assert_eq!(stored_screenshot_grants(), "");
    capture_while(&world, 25_000, |keys| {
        keys.press(KEY_TAB);
        std::thread::sleep(Duration::from_millis(400));
        keys.press(KEY_RETURN);
    })
    .expect("the first call is allowed by a person");
    let stored = stored_screenshot_grants();
    println!("portal_live grants after allow: {stored}");
    assert_eq!(stored, r#"screenshot=Some({"": ["yes"]})"#);
    for call in [2, 3] {
        let (outcome, took) = quick_capture();
        println!("portal_live call{call} {:?} in {took:?}", outcome.is_ok());
        assert!(outcome.is_ok(), "call {call} needs no dialog");
        assert!(took < Duration::from_secs(5), "{took:?}");
    }
}

#[test]
#[ignore = "boots a private headless gnome-shell and its portal; run inside scripts/private-session.sh"]
fn one_deny_is_remembered_and_later_calls_are_refused_at_once() {
    let world = boot();
    capture_while(&world, 25_000, |keys| keys.press(KEY_RETURN)).expect_err("denied");
    let stored = stored_screenshot_grants();
    println!("portal_live grants after deny: {stored}");
    assert_eq!(stored, r#"screenshot=Some({"": ["no"]})"#);
    let (outcome, took) = quick_capture();
    println!(
        "portal_live second call {:?} in {took:?}",
        outcome.as_ref().map_err(|e| e.code.clone()).err()
    );
    assert_eq!(outcome.expect_err("refused").code, ErrorCode::PermDenied);
    assert!(took < Duration::from_secs(5), "{took:?}");
}

#[test]
#[ignore = "boots a private headless gnome-shell with two virtual monitors; run inside scripts/private-session.sh"]
fn each_screen_is_its_rectangle_of_the_portals_image_on_two_monitors() {
    let world = boot_with(&["1280x800", "800x600"]);
    allow_screenshots();
    let whole = capture_target(&world, &ScreenshotTarget::FullScreen).expect("the desktop");
    assert_eq!(
        (whole.width, whole.height),
        (1280, 800),
        "no selector is the primary display, as on X11"
    );
    println!(
        "portal_live displays {:?}",
        crate::system::list_wayland_displays(Deadline::after(30_000).expect("a deadline"))
    );
    let first = capture_target(&world, &ScreenshotTarget::Screen(0)).expect("screen 0");
    let second = capture_target(&world, &ScreenshotTarget::Screen(1)).expect("screen 1");
    println!(
        "portal_live screens {}x{} and {}x{}",
        first.width, first.height, second.width, second.height
    );
    assert_eq!((first.width, first.height), (1280, 800));
    assert_eq!((second.width, second.height), (800, 600));
    assert!(
        blue_pixels(&first.data).2 >= 100_000,
        "the window is on screen 0"
    );
    assert_eq!(blue_pixels(&second.data).2, 0, "and not on screen 1");
}

#[test]
#[ignore = "boots a private headless gnome-shell with a scaled monitor; run inside scripts/private-session.sh"]
fn a_scaled_monitor_is_cropped_in_image_pixels() {
    let world = boot_with(&["2560x1600", "800x600"]);
    allow_screenshots();
    set_first_scale(2.0).expect("the shell accepts scale 2 for a 2560x1600 mode");
    std::thread::sleep(Duration::from_secs(3));
    let whole = capture_target(&world, &ScreenshotTarget::FullScreen).expect("the desktop");
    assert_eq!((whole.width, whole.height), (2560, 1600));
    let first = capture_target(&world, &ScreenshotTarget::Screen(0)).expect("screen 0");
    let second = capture_target(&world, &ScreenshotTarget::Screen(1)).expect("screen 1");
    println!(
        "portal_live scaled {}x{} and {}x{}",
        first.width, first.height, second.width, second.height
    );
    assert_eq!((first.width, first.height), (2560, 1600));
    assert_eq!((second.width, second.height), (800, 600));
    assert!(
        blue_pixels(&first.data).2 >= 400_000,
        "the 400x300 window is drawn at twice its size"
    );
    assert_eq!(blue_pixels(&second.data).2, 0);
}

fn bus_id(connection: &zbus::blocking::Connection) -> Option<String> {
    bus_call(connection, &BUS_DAEMON, "GetId", &())?
        .body()
        .deserialize::<String>()
        .ok()
}

#[test]
#[ignore = "boots a private headless gnome-shell and its portal; run inside scripts/private-session.sh"]
fn the_portal_calls_go_to_the_session_bus_and_not_the_accessibility_bus() {
    let world = boot();
    allow_screenshots();
    let session = zbus::blocking::Connection::session().expect("the session bus");
    let session_id = bus_id(&session).expect("the session bus id");
    let address = bus_call(
        &session,
        &Endpoint {
            destination: "org.a11y.Bus",
            path: "/org/a11y/bus",
            interface: "org.a11y.Bus",
        },
        "GetAddress",
        &(),
    )
    .expect("the accessibility bus address")
    .body()
    .deserialize::<String>()
    .expect("an address");
    let accessibility = zbus::blocking::connection::Builder::address(address.as_str())
        .expect("an address")
        .build()
        .expect("the accessibility bus");
    let accessibility_id = bus_id(&accessibility).expect("the accessibility bus id");
    let owns = |connection: &zbus::blocking::Connection| {
        bus_call(connection, &BUS_DAEMON, "NameHasOwner", &(FRONTEND,))
            .and_then(|reply| reply.body().deserialize::<bool>().ok())
            .unwrap_or(false)
    };
    let used = within(Deadline::after(10_000).expect("a deadline"), async {
        let connection = SessionBus::get(Deadline::after(10_000).expect("a deadline"))?;
        let reply = connection
            .call_method(
                Some("org.freedesktop.DBus"),
                "/org/freedesktop/DBus",
                Some("org.freedesktop.DBus"),
                "GetId",
                &(),
            )
            .await
            .map_err(|error| AdapterError::new(ErrorCode::ActionFailed, error.to_string()))?;
        reply
            .body()
            .deserialize::<String>()
            .map_err(|error| AdapterError::new(ErrorCode::ActionFailed, error.to_string()))
    })
    .expect("the portal connection answers");
    println!("portal_live buses are distinct and the portal answers on the session bus");
    assert_ne!(session_id, accessibility_id);
    assert_eq!(used, session_id);
    assert!(
        owns(&session),
        "the portal service lives on the session bus"
    );
    assert!(!owns(&accessibility), "and not on the accessibility bus");
    let image = capture_target(&world, &ScreenshotTarget::FullScreen).expect("the desktop");
    assert_eq!((image.width, image.height), (1280, 800));
}

#[test]
#[ignore = "boots a private headless gnome-shell and its portal; run inside scripts/private-session.sh"]
fn a_silent_dialog_ends_at_the_portals_limit_and_a_late_allow_leaves_nothing() {
    let world = boot();
    let before = home_screenshots();
    let started = Instant::now();
    let budget = crate::system::capture::screenshot::consent_deadline(
        Deadline::standard().expect("a deadline"),
    )
    .expect("a deadline");
    let silent = capture_wayland(&ScreenshotTarget::FullScreen, budget)
        .map(|image| image.width)
        .expect_err("no answer ends the request");
    println!(
        "portal_live silent {:?} {:?} after {:?}",
        silent.code,
        silent.message,
        started.elapsed()
    );
    assert_eq!(silent.code, ErrorCode::Timeout);
    assert!(
        silent
            .suggestion
            .as_deref()
            .is_some_and(|text| text.contains("dialog"))
    );
    world.keys.press(KEY_TAB);
    std::thread::sleep(Duration::from_millis(400));
    world.keys.press(KEY_RETURN);
    std::thread::sleep(Duration::from_secs(4));
    let new_files: Vec<_> = home_screenshots().difference(&before).cloned().collect();
    println!(
        "portal_live late allow files={new_files:?} grants={}",
        stored_screenshot_grants()
    );
    assert!(new_files.is_empty(), "a late Allow wrote {new_files:?}");
    assert_eq!(
        stored_screenshot_grants(),
        "",
        "a late Allow stored a grant"
    );
}

#[test]
#[ignore = "boots a private headless gnome-shell and its portal; run inside scripts/private-session.sh"]
fn a_second_request_while_a_dialog_is_open_names_the_open_dialog() {
    let world = boot();
    let mut second = None;
    let first = capture_while(&world, 9_000, |_| second = Some(quick_capture()));
    println!(
        "portal_live first {:?}",
        first.map(|image| image.width).map_err(|e| e.code)
    );
    let (outcome, took) = second.expect("the second call ran");
    let error = outcome.expect_err("the portal shows one dialog at a time");
    println!(
        "portal_live second {:?} in {took:?} {:?}",
        error.code, error.suggestion
    );
    assert_eq!(error.code, ErrorCode::PermDenied);
    assert!(took < Duration::from_secs(5));
    let hint = error.suggestion.expect("a hint");
    assert!(hint.contains("dialog left open"), "{hint}");
    assert!(!hint.contains("is remembered"), "{hint}");
}
