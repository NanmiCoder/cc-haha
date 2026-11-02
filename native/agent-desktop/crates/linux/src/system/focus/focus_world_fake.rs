use std::cell::{Cell, RefCell};

use agent_desktop_core::{ErrorCode, ProcessId, WindowState};

use crate::system::focus::restore_minimized::Lifted;

use super::*;
use crate::system::process::process_facts::ProcessFacts;
use crate::system::x11::stacking::stacked_window::StackedWindow;
use crate::system::x11::stacking::stacking_snapshot::StackingSnapshot;
use crate::system::x11::twin_tie::Twins;
use crate::system::x11::window::desktop_placement::DesktopPlacement;
use crate::system::x11::window::window_flags::WindowFlags;
use crate::system::x11::window::window_kind::WindowKind;
use crate::system::x11::{FrameExtents, X11Client};

pub(super) const CLIENT: u32 = 0x0040_0003;
pub(super) const OTHER: u32 = 0x0060_0001;
pub(super) const INSTANCE: &str = "abcd1234:99";

#[derive(Clone, Copy)]
pub(super) enum Grant {
    Never,
    Now,
    OnlyOnX11,
    AfterReads(u32),
    FrameAfterReads(u32),
}

pub(super) struct World {
    pub(super) session: Session,
    pub(super) lookup: Lookup,
    pub(super) minimized: Option<bool>,
    pub(super) state: X11State,
    pub(super) flags: WindowFlags,
    pub(super) global: bool,
    pub(super) grant: Grant,
    pub(super) send_fails: bool,
    pub(super) active: Cell<Option<u32>>,
    pub(super) frame_active: Cell<Option<bool>>,
    pub(super) sent: RefCell<Vec<u32>>,
    pub(super) active_reads: Cell<u32>,
    pub(super) lifted: Lifted,
    pub(super) lift_activates: bool,
    pub(super) writes: RefCell<Vec<String>>,
    pub(super) untimed_grants: bool,
    pub(super) modal: Option<String>,
    pub(super) stopped: bool,
    pub(super) desktop: DesktopPlacement,
    pub(super) current_desktop: Option<u32>,
    pub(super) overview: Option<bool>,
    pub(super) frame_modal: Option<bool>,
    pub(super) frame_dialog: bool,
    pub(super) input_focus: bool,
    pub(super) menu_open: bool,
    pub(super) app_frame_active: bool,
    pub(super) twins: Option<Twins>,
}

pub(super) fn facts() -> ProcessFacts {
    ProcessFacts {
        executable: None,
        comm: "app".to_owned(),
        exe_basename: None,
        instance: INSTANCE.to_owned(),
    }
}

pub(super) fn x11_client(id: u32, title: &str) -> X11Client {
    X11Client {
        shadow: (0, 0, 0, 0),
        id,
        hidden: false,
        pid: Some(100),
        title: title.to_owned(),
        extents: None,
        bounds: None,
    }
}

impl World {
    pub(super) fn new(active: Option<u32>) -> Self {
        Self {
            session: Session::X11,
            lookup: Lookup::Found(facts()),
            minimized: Some(false),
            state: X11State::Ready {
                active,
                clients: vec![x11_client(CLIENT, "Doc")],
            },
            flags: WindowFlags {
                hidden: false,
                above: false,
                mapped: true,
            },
            global: true,
            grant: Grant::Now,
            send_fails: false,
            active: Cell::new(active),
            frame_active: Cell::new(Some(active == Some(CLIENT))),
            sent: RefCell::new(Vec::new()),
            active_reads: Cell::new(0),
            lifted: Lifted::Cleared,
            lift_activates: false,
            writes: RefCell::new(Vec::new()),
            untimed_grants: false,
            modal: None,
            stopped: false,
            desktop: DesktopPlacement::On(0),
            current_desktop: Some(0),
            overview: None,
            frame_modal: None,
            frame_dialog: false,
            input_focus: false,
            menu_open: false,
            app_frame_active: false,
            twins: None,
        }
    }

    pub(super) fn sends(&self) -> usize {
        self.sent.borrow().len()
    }

    pub(super) fn lifts(&self) -> usize {
        self.writes
            .borrow()
            .iter()
            .filter(|write| *write == "lift")
            .count()
    }
}

impl ClientWorld for World {
    fn global_position(&self) -> bool {
        self.global
    }

    fn twins(&self, _win: &WindowInfo) -> Option<Twins> {
        self.twins.clone()
    }
}

impl FocusWorld for World {
    fn session(&self) -> Session {
        self.session
    }

    fn lookup(&self, _pid: u32) -> Lookup {
        self.lookup.clone()
    }

    fn frame(&self) -> Result<FrameView, AdapterError> {
        Ok(FrameView {
            minimized: self.minimized,
            active: self.frame_active.get(),
            modal: self.frame_modal,
            dialog: self.frame_dialog,
        })
    }

    fn clients(&self) -> X11State {
        self.state.clone()
    }

    fn stacking(&self, client: u32) -> StackingRead {
        StackingRead::Ready(StackingSnapshot {
            current_desktop: self.current_desktop,
            stack: vec![StackedWindow {
                shadow: (0, 0, 0, 0),
                id: client,
                flags: self.flags,
                desktop: self.desktop,
                kind: WindowKind::Normal,
                client: crate::tree::Extents {
                    x: 0,
                    y: 0,
                    width: 100,
                    height: 100,
                },
                extents: FrameExtents {
                    left: 0,
                    right: 0,
                    top: 0,
                    bottom: 0,
                },
            }],
            override_redirect_above: Vec::new(),
            override_redirect_receiving: Vec::new(),
            override_redirect_names: Vec::new(),
        })
    }

    fn stopped(&self, _pid: u32) -> bool {
        self.stopped
    }

    fn send_untimed(&self, client: u32) -> Result<(), ControlError> {
        self.writes.borrow_mut().push("send_untimed".to_owned());
        if self.untimed_grants {
            self.active.set(Some(client));
            self.frame_active.set(Some(true));
        }
        Ok(())
    }

    fn switch_desktop(&self, desktop: u32) -> Result<(), ActivateError> {
        self.writes.borrow_mut().push(format!("desktop {desktop}"));
        Ok(())
    }

    fn input_focus_in(&self, _client: u32) -> bool {
        self.input_focus
    }

    fn menu_open(&self) -> bool {
        self.menu_open
    }

    fn app_frame_active(&self) -> bool {
        self.app_frame_active
    }

    fn overview_open(&self) -> Option<bool> {
        self.overview
    }

    fn modal_over(&self, _client: u32) -> Option<String> {
        self.modal.clone()
    }

    fn lift(&self, _client: u32) -> Result<Lifted, AdapterError> {
        self.writes.borrow_mut().push("lift".to_owned());
        if self.lifted == Lifted::Cleared && self.lift_activates {
            self.active.set(Some(CLIENT));
            self.frame_active.set(Some(true));
        }
        Ok(self.lifted.clone())
    }

    fn send(&self, client: u32) -> Result<(), ControlError> {
        self.writes.borrow_mut().push("send".to_owned());
        self.sent.borrow_mut().push(client);
        if self.send_fails {
            return Err(ControlError::SendFailed);
        }
        match self.grant {
            Grant::Now => {
                self.active.set(Some(client));
                self.frame_active.set(Some(true));
            }
            Grant::OnlyOnX11 | Grant::FrameAfterReads(_) => self.active.set(Some(client)),
            Grant::Never | Grant::AfterReads(_) => {}
        }
        Ok(())
    }

    fn active(&self) -> Option<u32> {
        let reads = self.active_reads.get() + 1;
        self.active_reads.set(reads);
        if let Grant::AfterReads(needed) = self.grant
            && reads >= needed
            && self.sends() > 0
        {
            self.active.set(Some(CLIENT));
            self.frame_active.set(Some(true));
        }
        if let Grant::FrameAfterReads(needed) = self.grant
            && reads >= needed
            && self.sends() > 0
        {
            self.frame_active.set(Some(true));
        }
        self.active.get()
    }
}

pub(super) fn window() -> WindowInfo {
    WindowInfo {
        id: window_id::encode(":1.7", "/org/a11y/atspi/accessible/5").expect("an id"),
        title: "Doc".to_owned(),
        app: "app".to_owned(),
        pid: ProcessId::new(100),
        process_instance: Some(INSTANCE.to_owned()),
        bounds: None,
        state: WindowState::default(),
    }
}

pub(super) fn budget() -> Deadline {
    Deadline::after(10_000).expect("a deadline builds")
}

pub(super) fn failure(world: &World) -> AdapterError {
    run(world, &window(), budget()).expect_err("the focus must fail")
}

pub(super) fn assert_refused(error: &AdapterError, cause: &str) {
    assert_eq!(error.code, ErrorCode::ActionFailed);
    let details = error.details.as_ref().expect("details");
    assert_eq!(details["cause"], cause);
    assert_eq!(details["physical_delivery_started"], false);
}
