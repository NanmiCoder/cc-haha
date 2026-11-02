use std::cell::Cell;
use std::time::Duration;

use agent_desktop_core::{
    AdapterError, Deadline, ErrorCode, InteractionPolicy, WindowInfo, WindowState,
};

use crate::system::shell::kinds::ShellKind;
use crate::system::shell::light::Light;
use crate::system::shell::located::Located;
use crate::system::shell::open::{Opened, Surface, open_with, showing_of};
use crate::tree::AtspiElement;

struct World {
    showing: Cell<bool>,
    opens_on_press: bool,
    window_fails: bool,
    press_cleanup_fails: bool,
    presses: Cell<usize>,
    unbacked: bool,
}

impl World {
    fn closed() -> Self {
        Self {
            showing: Cell::new(false),
            opens_on_press: true,
            window_fails: false,
            press_cleanup_fails: false,
            presses: Cell::new(0),
            unbacked: false,
        }
    }

    fn open() -> Self {
        let world = Self::closed();
        world.showing.set(true);
        world
    }

    fn presses(&self) -> usize {
        self.presses.get()
    }
}

impl Surface for World {
    fn backed(&self, _kind: ShellKind, _deadline: Deadline) -> Result<(), AdapterError> {
        if self.unbacked {
            return Err(AdapterError::new(
                ErrorCode::PlatformNotSupported,
                "No system tray watcher is running in this session",
            )
            .with_details(serde_json::json!({ "watcher": "absent" })));
        }
        Ok(())
    }

    fn showing(&self, _kind: ShellKind, _deadline: Deadline) -> Result<bool, AdapterError> {
        Ok(self.showing.get())
    }

    fn press_opener(
        &self,
        _kind: ShellKind,
        _policy: InteractionPolicy,
    ) -> Result<(), AdapterError> {
        self.presses.set(self.presses.get() + 1);
        if !self.showing.get() && self.opens_on_press {
            self.showing.set(true);
        }
        if self.press_cleanup_fails {
            return Err(AdapterError::new(ErrorCode::ActionNotSupported, "Stop refused")
                .with_details(serde_json::json!({ "physical_delivery_started": true }))
                .with_disposition(agent_desktop_core::DeliverySemantics::delivered_unverified()));
        }
        Ok(())
    }

    fn window(&self, _kind: ShellKind, _deadline: Deadline) -> Result<WindowInfo, AdapterError> {
        if self.window_fails {
            return Err(AdapterError::timeout("window info could not be read"));
        }
        Ok(WindowInfo {
            id: "w-1-2-3".to_owned(),
            title: "t".to_owned(),
            app: "gnome-shell".to_owned(),
            pid: 1.into(),
            process_instance: None,
            bounds: None,
            state: WindowState::default(),
        })
    }

    fn pause(&self, duration: Duration) {
        std::thread::sleep(duration.min(Duration::from_millis(5)));
    }
}

fn deadline(ms: u64) -> Deadline {
    Deadline::after(ms).expect("a deadline builds")
}

fn open_standard(world: &World) -> Result<(WindowInfo, Opened), AdapterError> {
    open_with(
        world,
        ShellKind::MessageList,
        InteractionPolicy::headed(),
        deadline(2_000),
    )
}

#[test]
fn a_surface_already_showing_is_adopted_with_no_event() {
    let world = World::open();
    let (_, how) = open_standard(&world).expect("an open surface is adopted");
    assert_eq!(how, Opened::Adopted);
    assert_eq!(world.presses(), 0);
}

#[test]
fn failed_window_reads_preserve_surface_ownership() {
    for (already_showing, expected_owner, expected_presses) in [(true, false, 0), (false, true, 1)]
    {
        let mut world = if already_showing {
            World::open()
        } else {
            World::closed()
        };
        world.window_fails = true;
        let error = open_standard(&world).expect_err("window info failed");
        assert_eq!(
            error.details.expect("details")["surface_opened_by_call"],
            expected_owner
        );
        assert_eq!(world.presses(), expected_presses);
    }
}

#[test]
fn a_delivered_opener_error_preserves_ownership_for_restoration() {
    let mut world = World::closed();
    world.press_cleanup_fails = true;
    let error =
        open_standard(&world).expect_err("the click arrived but its pointer session did not stop");

    assert!(world.showing.get());
    assert_eq!(
        error.details.expect("opener progress")["surface_opened_by_call"],
        true
    );
    assert_eq!(world.presses(), 1);
    assert_eq!(
        error.disposition,
        agent_desktop_core::DeliverySemantics::delivered_unverified()
    );
}

#[test]
fn a_closed_surface_is_opened_by_one_press_and_left_open() {
    let world = World::closed();
    let (_, how) = open_with(
        &world,
        ShellKind::SystemMenu,
        InteractionPolicy::headed(),
        deadline(2_000),
    )
    .expect("the press opens it");
    assert_eq!(how, Opened::Opened);
    assert_eq!(world.presses(), 1);
    assert!(world.showing.get(), "the opened surface stays open");
}

#[test]
fn a_policy_that_is_not_headed_is_refused_before_the_first_event() {
    for policy in [
        InteractionPolicy::headless(),
        InteractionPolicy::focus_fallback(),
    ] {
        let world = World::closed();
        let error = open_with(&world, ShellKind::MessageList, policy, deadline(2_000))
            .expect_err("a click needs the cursor");
        assert_eq!(error.code, ErrorCode::PolicyDenied);
        assert_eq!(world.presses(), 0);
    }
}

#[test]
fn an_open_that_never_shows_is_a_timeout_after_the_click_was_sent() {
    let mut world = World::closed();
    world.opens_on_press = false;
    let error = open_with(
        &world,
        ShellKind::MessageList,
        InteractionPolicy::headed(),
        deadline(60),
    )
    .expect_err("the surface never shows");
    assert_eq!(error.code, ErrorCode::Timeout);
    assert_eq!(
        error.details.expect("details")["physical_delivery_started"],
        true
    );
    assert_eq!(world.presses(), 1);
}

#[test]
fn the_dock_and_the_tray_need_no_opener_even_headless() {
    for kind in [ShellKind::Dock, ShellKind::Tray] {
        let world = World::closed();
        let (_, how) = open_with(&world, kind, InteractionPolicy::headless(), deadline(2_000))
            .expect("nothing to open");
        assert_eq!(how, Opened::Adopted);
        assert_eq!(world.presses(), 0);
    }
}

fn light(showing: bool) -> Light {
    Light {
        element: AtspiElement::new(":1.2", "/n", 7),
        role: 43,
        name: String::new(),
        extents: None,
        showing,
        visible: true,
        children: Vec::new(),
    }
}

#[test]
fn showing_uses_the_surface_specific_visibility_source() {
    for (kind, anchor_showing, container_showing, expected) in [
        (ShellKind::MessageList, false, true, true),
        (ShellKind::MessageList, true, false, false),
        (ShellKind::SystemMenu, true, false, true),
    ] {
        let located = Located {
            anchor: light(anchor_showing),
            container: light(container_showing),
        };
        assert_eq!(showing_of(kind, &located), expected, "{kind:?}");
    }
}

#[test]
fn closed_popups_have_no_observable_window_even_when_their_nodes_exist() {
    let root = crate::system::shell::identity::ShellRoot {
        bus_name: ":1.2".into(),
        path: "/root".into(),
        pid: 7,
    };
    for (kind, anchor_showing, container_showing, open) in [
        (ShellKind::MessageList, false, false, false),
        (ShellKind::SystemMenu, false, true, false),
        (ShellKind::MessageList, false, true, true),
        (ShellKind::SystemMenu, true, false, true),
        (ShellKind::Tray, false, false, true),
    ] {
        let located = Located {
            anchor: light(anchor_showing),
            container: light(container_showing),
        };
        let result = super::window_info(kind, &root, &located);
        if open {
            assert!(result.expect("an open surface has a window").state.visible == Some(true));
        } else {
            assert_eq!(
                result.expect_err("the popup is closed").code,
                ErrorCode::WindowNotFound
            );
        }
    }
}

#[test]
fn a_surface_without_its_backing_service_is_refused_before_it_is_adopted() {
    let world = World {
        unbacked: true,
        ..World::open()
    };
    let error = open_with(
        &world,
        ShellKind::Tray,
        InteractionPolicy::headless(),
        deadline(1_000),
    )
    .expect_err("no watcher means no tray");

    assert_eq!(error.code, ErrorCode::PlatformNotSupported);
    let details = error.details.expect("refusal details");
    assert_eq!(details["watcher"], "absent");
    assert_eq!(details["surface_opened_by_call"], false);
    assert_eq!(world.presses(), 0);
}
