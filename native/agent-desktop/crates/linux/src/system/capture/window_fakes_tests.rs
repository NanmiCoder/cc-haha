use std::collections::HashMap;
use std::sync::Mutex;
use std::sync::atomic::{AtomicUsize, Ordering};

use agent_desktop_core::{
    AdapterError, Deadline, DisplayInfo, ImageBuffer, ImageFormat, ProcessId, Rect, WindowInfo,
    WindowState,
};

pub(crate) use super::world::{FakeLookup, FakeStacking, Seq};
use super::*;
use crate::system::capture::pixels::VisualFormat;
use crate::system::capture::window_xid::XidOutcome;
use crate::system::x11::X11State;
use crate::system::x11::capture::drawable_info::DrawableInfo;
use crate::system::x11::capture::grab::{Grabber, Raw};
use crate::system::x11::capture::grab_error::GrabError;
use crate::system::x11::stacking::stacked_window::StackedWindow;
use crate::system::x11::stacking::stacking_read::StackingRead;
use crate::system::x11::stacking::stacking_snapshot::StackingSnapshot;
use crate::system::x11::window::desktop_placement::DesktopPlacement;
use crate::system::x11::window::window_flags::WindowFlags;
use crate::system::x11::window::window_kind::WindowKind;
use crate::system::x11::{FrameExtents, MonitorFault};

pub(crate) const CLIENT: u32 = 10;
pub(crate) const FRAME: u32 = 20;

#[derive(Clone)]
pub(crate) struct Drawn {
    pub(crate) rect: Extents,
    pub(crate) parent: Option<u32>,
    pub(crate) state: u8,
}

pub(crate) fn extents(x: i32, y: i32, width: i32, height: i32) -> Extents {
    Extents {
        x,
        y,
        width,
        height,
    }
}

pub(crate) type GrabLog = (u32, (i16, i16, u16, u16));

pub(crate) type GrabFn = Box<dyn Fn(u32, GrabRect) -> Result<Raw, GrabError> + Send + Sync>;

pub(crate) struct FakeGrabber {
    pub(crate) drawn: Mutex<HashMap<u32, Seq<Drawn>>>,
    pub(crate) shadows: Mutex<HashMap<u32, FrameExtents>>,
    pub(crate) compositing: Mutex<Result<bool, fn() -> GrabError>>,
    pub(crate) grab_with: Mutex<GrabFn>,
    pub(crate) redirect_with: Mutex<GrabFn>,
    pub(crate) redirects: Mutex<Vec<GrabLog>>,
    pub(crate) calls: AtomicUsize,
    pub(crate) grabs: Mutex<Vec<GrabLog>>,
}

pub(crate) fn raw_of(rect: GrabRect) -> Raw {
    let (width, height) = (u32::from(rect.width), u32::from(rect.height));
    Raw {
        data: vec![7; (width * height * 3) as usize],
        width,
        height,
        stride: (width * 3) as usize,
        format: VisualFormat {
            red_mask: 0xff0000,
            green_mask: 0xff00,
            blue_mask: 0xff,
            bits_per_pixel: 24,
            depth: 24,
            scanline_pad: 32,
            msb_first: false,
        },
    }
}

impl FakeGrabber {
    pub(crate) fn describe_as(&self, id: u32, items: Vec<Drawn>) {
        self.drawn
            .lock()
            .expect("drawn lock")
            .insert(id, Seq::of(items));
    }

    pub(crate) fn shadow_as(&self, id: u32, shadow: FrameExtents) {
        self.shadows
            .lock()
            .expect("shadows lock")
            .insert(id, shadow);
    }

    pub(crate) fn redirect_count(&self) -> usize {
        self.redirects.lock().expect("redirects lock").len()
    }

    pub(crate) fn redirect_works(&self) {
        *self.redirect_with.lock().expect("redirect lock") = Box::new(|_, rect| Ok(raw_of(rect)));
    }

    pub(crate) fn grab_count(&self) -> usize {
        self.grabs.lock().expect("grabs lock").len()
    }

    pub(crate) fn last_grab(&self) -> GrabLog {
        *self
            .grabs
            .lock()
            .expect("grabs lock")
            .last()
            .expect("a grab was issued")
    }
}

impl Grabber for FakeGrabber {
    fn describe(&self, window: u32, _deadline: Deadline) -> Result<DrawableInfo, GrabError> {
        self.calls.fetch_add(1, Ordering::SeqCst);
        let drawn = self.drawn.lock().expect("drawn lock");
        let seq = drawn.get(&window).ok_or(GrabError::Gone)?;
        let at = seq.next();
        Ok(DrawableInfo {
            rect: at.rect,
            parent: at.parent,
            depth: 24,
            map_state: match at.state {
                0 => MapState::Viewable,
                1 => MapState::Unviewable,
                _ => MapState::Unmapped,
            },
            override_redirect: false,
            shadow: self
                .shadows
                .lock()
                .expect("shadows lock")
                .get(&window)
                .copied(),
        })
    }

    fn grab(&self, drawable: u32, rect: GrabRect, _deadline: Deadline) -> Result<Raw, GrabError> {
        self.calls.fetch_add(1, Ordering::SeqCst);
        self.grabs
            .lock()
            .expect("grabs lock")
            .push((drawable, (rect.x, rect.y, rect.width, rect.height)));
        (self.grab_with.lock().expect("grab lock"))(drawable, rect)
    }

    fn grab_redirected(
        &self,
        window: u32,
        rect: GrabRect,
        _deadline: Deadline,
    ) -> Result<Raw, GrabError> {
        self.calls.fetch_add(1, Ordering::SeqCst);
        self.redirects
            .lock()
            .expect("redirects lock")
            .push((window, (rect.x, rect.y, rect.width, rect.height)));
        (self.redirect_with.lock().expect("redirect lock"))(window, rect)
    }

    fn compositing(&self, _deadline: Deadline) -> Result<bool, GrabError> {
        self.calls.fetch_add(1, Ordering::SeqCst);
        self.compositing
            .lock()
            .expect("compositing lock")
            .map_err(|make| make())
    }
}

pub(crate) struct Rig {
    pub(crate) grabber: FakeGrabber,
    pub(crate) stacking: FakeStacking,
    pub(crate) lookup: FakeLookup,
    pub(crate) stopped: fn(u32) -> bool,
}

pub(crate) fn never_stopped(_pid: u32) -> bool {
    false
}

pub(crate) fn always_stopped(_pid: u32) -> bool {
    true
}

pub(crate) fn decode(raw: &Raw) -> Result<Vec<u8>, AdapterError> {
    Ok(raw.data.clone())
}

pub(crate) fn encode(
    rgb: &[u8],
    width: u32,
    height: u32,
    scale_factor: f64,
) -> Result<ImageBuffer, AdapterError> {
    Ok(ImageBuffer {
        data: rgb.to_vec(),
        format: ImageFormat::Png,
        width,
        height,
        scale_factor,
    })
}

pub(crate) fn window_info(bounds: Option<Rect>) -> WindowInfo {
    WindowInfo {
        id: "w1".to_owned(),
        title: "Editor".to_owned(),
        app: "editor".to_owned(),
        pid: ProcessId::new(4),
        process_instance: Some("instance".to_owned()),
        bounds,
        state: WindowState {
            is_focused: false,
            accessible: true,
            minimized: Some(false),
            visible: Some(true),
        },
    }
}

pub(crate) fn frame_bounds() -> Option<Rect> {
    Some(Rect {
        x: 100.0,
        y: 100.0,
        width: 1000.0,
        height: 737.0,
    })
}

pub(crate) fn display_at(id: &str, x: f64, width: f64, scale: f64, primary: bool) -> DisplayInfo {
    DisplayInfo {
        id: id.to_owned(),
        bounds: Rect {
            x,
            y: 0.0,
            width,
            height: 1080.0,
        },
        is_primary: primary,
        scale,
    }
}

pub(crate) fn stacked(id: u32, client: Extents) -> StackedWindow {
    StackedWindow {
        id,
        flags: WindowFlags {
            hidden: false,
            above: false,
            mapped: true,
        },
        desktop: DesktopPlacement::On(0),
        kind: WindowKind::Normal,
        client,
        extents: FrameExtents {
            left: 0,
            right: 0,
            top: 0,
            bottom: 0,
        },
        shadow: (0, 0, 0, 0),
    }
}

pub(crate) fn snapshot(stack: Vec<StackedWindow>, above: Vec<Extents>) -> StackingRead {
    StackingRead::Ready(StackingSnapshot {
        current_desktop: Some(0),
        stack,
        override_redirect_above: above,
        override_redirect_receiving: Vec::new(),
        override_redirect_names: Vec::new(),
    })
}

pub(crate) fn clear_read() -> StackingRead {
    snapshot(
        vec![stacked(CLIENT, extents(101, 138, 1000, 700))],
        Vec::new(),
    )
}

impl Rig {
    pub(crate) fn standard() -> Self {
        let grabber = FakeGrabber {
            drawn: Mutex::new(HashMap::new()),
            shadows: Mutex::new(HashMap::new()),
            compositing: Mutex::new(Ok(false)),
            grab_with: Mutex::new(Box::new(|_, rect| Ok(raw_of(rect)))),
            redirect_with: Mutex::new(Box::new(|_, _| {
                Err(GrabError::Fault(MonitorFault::Unreadable))
            })),
            redirects: Mutex::new(Vec::new()),
            calls: AtomicUsize::new(0),
            grabs: Mutex::new(Vec::new()),
        };
        grabber.describe_as(
            CLIENT,
            vec![Drawn {
                rect: extents(1, 38, 1000, 700),
                parent: Some(FRAME),
                state: 0,
            }],
        );
        grabber.describe_as(
            FRAME,
            vec![Drawn {
                rect: extents(100, 100, 1002, 739),
                parent: None,
                state: 0,
            }],
        );
        Self {
            grabber,
            stacking: FakeStacking {
                reads: Seq::of(vec![clear_read()]),
                per_target: Mutex::new(HashMap::new()),
                clients: Mutex::new(X11State::Unavailable),
                read_count: AtomicUsize::new(0),
            },
            lookup: FakeLookup {
                resolved: Seq::of(vec![Some(window_info(frame_bounds()))]),
                xids: Seq::of(vec![XidOutcome::One(CLIENT)]),
                displays: Seq::of(vec![Some(vec![display_at("A", 0.0, 1920.0, 1.0, true)])]),
                calls: AtomicUsize::new(0),
            },
            stopped: never_stopped,
        }
    }

    pub(crate) fn env(&self) -> CaptureEnv<'_> {
        CaptureEnv {
            grabber: &self.grabber,
            stacking: &self.stacking,
            lookup: &self.lookup,
            decode,
            encode,
            stopped: self.stopped,
        }
    }

    pub(crate) fn compose_on(&self) {
        *self.grabber.compositing.lock().expect("compositing lock") = Ok(true);
    }

    pub(crate) fn x11_touched(&self) -> usize {
        self.grabber.calls.load(Ordering::SeqCst)
            + self.stacking.read_count.load(Ordering::SeqCst)
            + self.lookup.calls.load(Ordering::SeqCst)
    }
}

pub(crate) fn deadline() -> Deadline {
    Deadline::after(5_000).expect("a five second deadline")
}

pub(crate) fn target() -> WindowInfo {
    window_info(frame_bounds())
}
