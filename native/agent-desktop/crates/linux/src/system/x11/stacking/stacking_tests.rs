use std::cell::Cell;
use std::sync::atomic::{AtomicU32, Ordering};
use std::time::Duration;

use super::*;
use crate::system::display::display_cause::Cause;
use crate::system::display::display_unavailable::Unavailable;
use crate::system::x11::stacking::stacked_window::StackedWindow;
use crate::system::x11::stacking::stacking_snapshot::StackingSnapshot;
use crate::system::x11::window::desktop_placement::DesktopPlacement;
use crate::system::x11::window::window_flags::WindowFlags;
use crate::system::x11::window::window_kind::WindowKind;
use crate::system::x11::{FrameExtents, X11Client};
use crate::tree::Extents;

fn window(id: u32, hidden: bool, x: i32, y: i32) -> StackedWindow {
    StackedWindow {
        shadow: (0, 0, 0, 0),
        id,
        flags: WindowFlags {
            hidden,
            above: false,
            mapped: true,
        },
        desktop: DesktopPlacement::On(0),
        kind: WindowKind::Normal,
        client: Extents {
            x,
            y,
            width: 300,
            height: 200,
        },
        extents: FrameExtents {
            left: 0,
            right: 0,
            top: 0,
            bottom: 0,
        },
    }
}

struct Fixed {
    clients: X11State,
    stack: StackingRead,
    reads: AtomicU32,
}

impl StackingSource for Fixed {
    fn read_within(&self, _target_client: u32, _deadline: Deadline) -> StackingRead {
        self.reads.fetch_add(1, Ordering::SeqCst);
        self.stack.clone()
    }

    fn clients_within(&self, _deadline: Deadline) -> X11State {
        self.clients.clone()
    }
}

fn client(id: u32, pid: u32, title: &str) -> X11Client {
    X11Client {
        shadow: (0, 0, 0, 0),
        id,
        hidden: false,
        pid: Some(pid),
        title: title.to_owned(),
        extents: None,
        bounds: None,
    }
}

fn facts(pid: u32, title: &str) -> FrameFacts {
    FrameFacts {
        size_identity: false,
        pid,
        title: title.to_owned(),
        extents: None,
        global_position: false,
    }
}

fn ready(clients: Vec<X11Client>) -> X11State {
    X11State::Ready {
        active: None,
        clients,
    }
}

fn snapshot(stack: Vec<StackedWindow>) -> StackingRead {
    StackingRead::Ready(StackingSnapshot {
        current_desktop: Some(0),
        stack,
        override_redirect_above: Vec::new(),
        override_redirect_receiving: Vec::new(),
        override_redirect_names: Vec::new(),
    })
}

fn deadline() -> Deadline {
    Deadline::after(2_000).expect("a deadline builds")
}

fn state_of(source: &dyn StackingSource, deadline: Deadline, frame: &FrameFacts) -> FrameWindow {
    frame_window_state(source, deadline, frame, || None)
}

#[test]
fn a_window_with_no_single_client_has_no_state_and_reads_no_stacking() {
    let cases = [
        (
            ready(vec![client(5, 10, "Doc"), client(6, 10, "Doc")]),
            FrameWindow::Tied {
                hidden: Some(false),
            },
        ),
        (ready(vec![client(5, 99, "Doc")]), FrameWindow::Unknown),
    ];
    for (clients, expected) in cases {
        let source = Fixed {
            clients,
            stack: snapshot(vec![window(5, false, 0, 0)]),
            reads: AtomicU32::new(0),
        };
        assert_eq!(state_of(&source, deadline(), &facts(10, "Doc")), expected);
        assert_eq!(source.reads.load(Ordering::SeqCst), 0);
    }
}

#[test]
fn without_x11_evidence_a_window_has_no_state() {
    let nothing = [
        StackingRead::NotX11,
        StackingRead::NoManager,
        StackingRead::Unavailable,
        snapshot(vec![window(9, false, 0, 0)]),
    ];
    for stack in nothing {
        let source = Fixed {
            clients: ready(vec![client(5, 10, "Doc")]),
            stack,
            reads: AtomicU32::new(0),
        };
        assert_eq!(
            state_of(&source, deadline(), &facts(10, "Doc")),
            FrameWindow::Unknown
        );
    }
    for clients in [X11State::Unavailable, X11State::NoWindowManager] {
        let source = Fixed {
            clients,
            stack: snapshot(vec![window(5, false, 0, 0)]),
            reads: AtomicU32::new(0),
        };
        assert_eq!(
            state_of(&source, deadline(), &facts(10, "Doc")),
            FrameWindow::Unknown
        );
    }
}

#[test]
fn a_wayland_session_answers_not_x11_without_a_connection() {
    let opened = Cell::new(false);
    let read = route(DisplayServer::Wayland, |_| {
        opened.set(true);
        StackingRead::NoManager
    });
    assert_eq!(read, StackingRead::NotX11);
    assert!(!opened.get());
}

#[test]
fn a_session_with_no_display_is_unavailable_without_a_connection() {
    let opened = Cell::new(false);
    let none = Unavailable {
        cause: Cause::NotConfigured,
        detail: String::new(),
    };
    let read = route(DisplayServer::Unavailable(none), |_| {
        opened.set(true);
        StackingRead::NoManager
    });
    assert_eq!(read, StackingRead::Unavailable);
    assert!(!opened.get());
}

struct Slow {
    clients: X11State,
    stack: StackingRead,
}

impl StackingSource for Slow {
    fn read_within(&self, _target_client: u32, _deadline: Deadline) -> StackingRead {
        std::thread::sleep(Duration::from_millis(120));
        self.stack.clone()
    }

    fn clients_within(&self, _deadline: Deadline) -> X11State {
        self.clients.clone()
    }
}

#[test]
fn a_read_that_ends_after_the_callers_deadline_gives_no_state() {
    let source = Slow {
        clients: ready(vec![client(5, 10, "Doc")]),
        stack: snapshot(vec![window(5, true, 120, 80)]),
    };
    let budget = Deadline::after(60).expect("a deadline builds");
    assert_eq!(
        state_of(&source, budget, &facts(10, "Doc")),
        FrameWindow::Unknown
    );
}

#[test]
fn the_one_client_of_a_window_gives_its_state() {
    let source = Fixed {
        clients: ready(vec![client(5, 10, "Doc"), client(6, 10, "Other")]),
        stack: snapshot(vec![window(5, true, 120, 80)]),
        reads: AtomicU32::new(0),
    };
    assert_eq!(
        state_of(&source, deadline(), &facts(10, "Doc")),
        FrameWindow::Client(WindowX11State {
            client_id: 5,
            hidden: true,
            client_origin: (120, 80),
            shadow: (0, 0, 0, 0),
        })
    );
}

fn tied_source(active: Option<u32>) -> Fixed {
    Fixed {
        clients: X11State::Ready {
            active,
            clients: vec![client(5, 10, "Doc"), client(6, 10, "Doc")],
        },
        stack: snapshot(vec![window(5, false, 10, 20), window(6, false, 300, 400)]),
        reads: AtomicU32::new(0),
    }
}

#[test]
fn a_tie_the_twins_break_gives_the_state_of_the_client_they_name() {
    let source = tied_source(Some(6));
    let twins = || {
        Some(Twins {
            active: vec![false, true],
            me: 0,
        })
    };
    let FrameWindow::Client(state) =
        frame_window_state(&source, deadline(), &facts(10, "Doc"), twins)
    else {
        panic!("the inactive twin is the other client");
    };
    assert_eq!((state.client_id, state.client_origin), (5, (10, 20)));
}

#[test]
fn a_tie_nothing_breaks_stays_tied_and_reads_no_stacking() {
    for active in [None, Some(99)] {
        let source = tied_source(active);
        let twins = || {
            Some(Twins {
                active: vec![false, true],
                me: 0,
            })
        };
        assert_eq!(
            frame_window_state(&source, deadline(), &facts(10, "Doc"), twins),
            FrameWindow::Tied {
                hidden: Some(false)
            }
        );
        assert_eq!(source.reads.load(Ordering::SeqCst), 0);
    }
}
