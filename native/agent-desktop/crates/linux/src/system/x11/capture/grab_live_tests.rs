use std::time::{Duration, Instant};

use agent_desktop_core::Deadline;
use x11rb::connection::Connection;
use x11rb::protocol::xproto::{ConnectionExt, CreateWindowAux, WindowClass};
use x11rb::rust_connection::RustConnection;
use x11rb::wrapper::ConnectionExt as _;

use super::*;
use crate::system::capture::pixels::to_rgb;
use crate::system::capture::png_encode::encode_png;
use crate::system::x11::capture::map_state::MapState;
use crate::system::x11::capture::xwd_oracle::{wait_viewable, xwd_pixel};

const FILL: [u8; 3] = [0x33, 0x66, 0x99];
const ORIGIN: (i16, i16) = (100, 90);
const SIZE: (u16, u16) = (200, 120);
const RELEASED_WITHIN: Duration = Duration::from_secs(5);

fn deadline() -> Deadline {
    Deadline::after(10_000).expect("a deadline builds")
}

fn independent_compositing(display: &str) -> bool {
    let (connection, screen) = RustConnection::connect(Some(display)).expect("connect");
    let atom = connection
        .intern_atom(false, format!("_NET_WM_CM_S{screen}").as_bytes())
        .expect("intern")
        .reply()
        .expect("atom")
        .atom;
    connection
        .get_selection_owner(atom)
        .expect("owner")
        .reply()
        .expect("reply")
        .owner
        != 0
}

fn root_origin(flat: &Flat) -> (i32, i32) {
    let root = flat.connection.setup().roots[0].root;
    let origin = flat
        .connection
        .translate_coordinates(flat.window, root, 0, 0)
        .expect("translate")
        .reply()
        .expect("origin");
    (i32::from(origin.dst_x), i32::from(origin.dst_y))
}

struct Flat {
    connection: RustConnection,
    window: u32,
}

/// A window manager tears a framed window down after its client is gone and
/// still sends requests for the client's id then. The next connection is given
/// the same id, so a window it creates before the teardown ends is moved and
/// resized by those requests. The manager destroys the frame after them.
fn wait_released(connection: &RustConnection, frame: u32) {
    let started = Instant::now();
    while connection
        .get_window_attributes(frame)
        .ok()
        .and_then(|cookie| cookie.reply().ok())
        .is_some()
    {
        if started.elapsed() >= RELEASED_WITHIN {
            assert!(
                std::thread::panicking(),
                "the window manager still holds frame {frame:#x} of a destroyed window"
            );
            return;
        }
        std::thread::sleep(Duration::from_millis(5));
    }
}

impl Drop for Flat {
    fn drop(&mut self) {
        let frame = self.frame();
        let _ = self.connection.destroy_window(self.window);
        let _ = self.connection.sync();
        if let Some(frame) = frame {
            wait_released(&self.connection, frame);
        }
    }
}

impl Flat {
    fn new(display: &str) -> Self {
        Self::at(display, ORIGIN, SIZE, FILL, true)
    }

    fn frame(&self) -> Option<u32> {
        let root = self.connection.setup().roots[0].root;
        let parent = self
            .connection
            .query_tree(self.window)
            .ok()?
            .reply()
            .ok()?
            .parent;
        (parent != root).then_some(parent)
    }

    fn at(display: &str, origin: (i16, i16), size: (u16, u16), fill: [u8; 3], bare: bool) -> Self {
        let (connection, screen) = RustConnection::connect(Some(display)).expect("connect");
        let root = connection.setup().roots[screen].root;
        let window = connection.generate_id().expect("an id");
        let pixel = u32::from_be_bytes([0, fill[0], fill[1], fill[2]]);
        connection
            .create_window(
                x11rb::COPY_DEPTH_FROM_PARENT,
                window,
                root,
                origin.0,
                origin.1,
                size.0,
                size.1,
                0,
                WindowClass::INPUT_OUTPUT,
                0,
                &CreateWindowAux::new()
                    .background_pixel(pixel)
                    .override_redirect(u32::from(bare)),
            )
            .expect("create")
            .check()
            .expect("the window is created");
        Self { connection, window }
    }

    fn map(&self) {
        self.connection.map_window(self.window).expect("map");
        self.connection.sync().expect("sync");
    }

    fn unmap(&self) {
        self.connection.unmap_window(self.window).expect("unmap");
        self.connection.sync().expect("sync");
    }
}

fn grab_when_painted(window: u32, rect: GrabRect) -> Raw {
    let started = Instant::now();
    loop {
        match DisplayGrabber.grab(window, rect, deadline()) {
            Ok(raw) => return raw,
            Err(error) if started.elapsed() > Duration::from_secs(10) => {
                panic!("the window never became grabbable: {error:?}")
            }
            Err(_) => std::thread::sleep(Duration::from_millis(100)),
        }
    }
}

#[test]
#[ignore = "needs a private X session; run through scripts/private-session.sh --wm"]
fn grab_live_a_flat_window_reads_back_its_fill_and_matches_an_independent_capture() {
    let display = crate::system::x11::live_display::private_display();
    let dir = std::env::var("AGENT_DESKTOP_PRIVATE_SESSION").expect("a private session");
    let flat = Flat::new(&display);
    flat.map();
    let whole = GrabRect {
        x: 0,
        y: 0,
        width: SIZE.0,
        height: SIZE.1,
    };
    let raw = grab_when_painted(flat.window, whole);
    println!("grab_live format={:?} stride={}", raw.format, raw.stride);
    assert_eq!(
        (raw.width, raw.height),
        (u32::from(SIZE.0), u32::from(SIZE.1))
    );
    let rgb = to_rgb(&raw.format, &raw.data, raw.width, raw.height, raw.stride).expect("converts");
    assert!(rgb.chunks_exact(3).all(|pixel| pixel == FILL));
    wait_viewable(&flat.connection, flat.window);
    assert_eq!(xwd_pixel(flat.window, 50, 40, &dir), FILL);
    let png = encode_png(&rgb, raw.width, raw.height, 1.0).expect("encodes");
    assert_eq!(
        agent_desktop_core::parse_png_dimensions(&png.data),
        Some((200, 120))
    );
    let part = DisplayGrabber
        .grab(
            flat.window,
            GrabRect {
                x: 10,
                y: 20,
                width: 50,
                height: 30,
            },
            deadline(),
        )
        .expect("a crop grabs");
    assert_eq!((part.width, part.height), (50, 30));
    let crop = to_rgb(&part.format, &part.data, 50, 30, part.stride).expect("converts");
    assert!(crop.chunks_exact(3).all(|pixel| pixel == FILL));
}

#[test]
#[ignore = "needs a private X session; run through scripts/private-session.sh --wm"]
fn grab_live_describes_the_window_and_names_each_refusal() {
    let display = crate::system::x11::live_display::private_display();
    let flat = Flat::new(&display);
    let unmapped = DisplayGrabber
        .describe(flat.window, deadline())
        .expect("describes the unmapped client");
    assert_eq!((unmapped.rect.x, unmapped.rect.y), root_origin(&flat));
    assert_eq!(unmapped.map_state, MapState::Unmapped);
    flat.map();
    wait_viewable(&flat.connection, flat.window);
    let info = DisplayGrabber
        .describe(flat.window, deadline())
        .expect("describes");
    println!("grab_live info={info:?}");
    assert_eq!((info.rect.width, info.rect.height), (200, 120));
    assert_eq!(info.map_state, MapState::Viewable);
    assert!(info.override_redirect);
    assert_eq!(info.parent, None);
    let root = DisplayGrabber.describe(0, deadline()).expect("the root");
    assert_eq!((root.rect.width, root.rect.height), (1280, 800));
    let beyond = GrabRect {
        x: 150,
        y: 0,
        width: 100,
        height: 50,
    };
    assert_eq!(
        DisplayGrabber.grab(flat.window, beyond, deadline()).err(),
        Some(GrabError::OffScreen)
    );
    flat.unmap();
    let whole = GrabRect {
        x: 0,
        y: 0,
        width: 10,
        height: 10,
    };
    assert_eq!(
        DisplayGrabber.grab(flat.window, whole, deadline()).err(),
        Some(GrabError::Unviewable)
    );
    let gone = flat.window;
    flat.connection.destroy_window(gone).expect("destroy");
    flat.connection.sync().expect("sync");
    assert_eq!(
        DisplayGrabber.grab(gone, whole, deadline()).err(),
        Some(GrabError::Gone)
    );
    assert_eq!(
        DisplayGrabber.describe(gone, deadline()).err(),
        Some(GrabError::Gone)
    );
}

#[test]
#[ignore = "needs a private X session; run through scripts/private-session.sh --wm"]
fn grab_live_the_root_grab_and_the_compositing_read_answer_on_the_private_screen() {
    let display = crate::system::x11::live_display::private_display();
    assert_eq!(
        DisplayGrabber.compositing(deadline()),
        Ok(independent_compositing(&display))
    );
    let rect = GrabRect {
        x: 0,
        y: 0,
        width: 1280,
        height: 800,
    };
    let raw = DisplayGrabber
        .grab(0, rect, deadline())
        .expect("the root grabs");
    assert_eq!((raw.width, raw.height), (1280, 800));
    assert_eq!(raw.data.len(), raw.stride * 800);
}

#[test]
#[ignore = "needs a private X session; run through scripts/private-session.sh --wm"]
fn grab_live_a_framed_window_has_a_parent_and_every_rect_is_in_root_coordinates() {
    let display = crate::system::x11::live_display::private_display();
    let framed = Flat::at(&display, (300, 200), (150, 100), FILL, false);
    framed.map();
    let started = Instant::now();
    let info = loop {
        let info = DisplayGrabber
            .describe(framed.window, deadline())
            .expect("describes");
        if (info.parent.is_some() && info.map_state == MapState::Viewable)
            || started.elapsed() > Duration::from_secs(10)
        {
            break info;
        }
        std::thread::sleep(Duration::from_millis(100));
    };
    println!("grab_live framed={info:?}");
    let frame = info
        .parent
        .expect("the manager reparents the window into a frame");
    let outer = DisplayGrabber
        .describe(frame, deadline())
        .expect("the frame");
    assert_eq!(outer.parent, None);
    assert!(outer.rect.x <= info.rect.x && outer.rect.y <= info.rect.y);
    assert!(outer.rect.width >= info.rect.width && outer.rect.height >= info.rect.height);
    assert_eq!(
        (info.rect.x, info.rect.y),
        root_origin(&framed),
        "the client origin is in root coordinates, not relative to the frame"
    );
    assert_eq!((info.rect.width, info.rect.height), (150, 100));
    assert!(
        outer.rect.y < info.rect.y,
        "a title bar sits above the client"
    );
}

#[test]
#[ignore = "needs a private X session; run through scripts/private-session.sh --wm"]
fn grab_live_a_covered_window_is_blank_directly_and_painted_through_the_redirect() {
    let display = crate::system::x11::live_display::private_display();
    let covered = Flat::at(&display, (100, 90), (100, 80), FILL, true);
    covered.map();
    let rect = GrabRect {
        x: 0,
        y: 0,
        width: 100,
        height: 80,
    };
    grab_when_painted(covered.window, rect);
    let cover = Flat::at(&display, (60, 60), (300, 200), [0xcc, 0x22, 0x22], true);
    cover.map();
    std::thread::sleep(Duration::from_millis(300));
    let direct = DisplayGrabber
        .grab(covered.window, rect, deadline())
        .expect("a direct grab");
    let direct = to_rgb(&direct.format, &direct.data, 100, 80, direct.stride).expect("converts");
    if independent_compositing(&display) {
        assert!(
            direct.chunks_exact(3).all(|pixel| pixel == FILL),
            "a compositor keeps a covered window's own pixels"
        );
    } else {
        assert!(
            direct.chunks_exact(3).all(|pixel| pixel != FILL),
            "a covered window reads its cover or nothing"
        );
    }
    let through = DisplayGrabber
        .grab_redirected(covered.window, rect, deadline())
        .expect("a redirected grab");
    let through =
        to_rgb(&through.format, &through.data, 100, 80, through.stride).expect("converts");
    assert!(through.chunks_exact(3).all(|pixel| pixel == FILL));
    covered.unmap();
    assert_eq!(
        DisplayGrabber
            .grab_redirected(covered.window, rect, deadline())
            .err(),
        Some(GrabError::Unviewable)
    );
}
