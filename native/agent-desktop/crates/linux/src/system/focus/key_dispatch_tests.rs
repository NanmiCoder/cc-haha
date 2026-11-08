use std::cell::{Cell, RefCell};
use std::collections::VecDeque;

use agent_desktop_core::{
    DeliverySemantics, ErrorCode, InteractionPolicy, KeyCombo, ProcessId, ProcessIdentity,
};

use super::*;
use crate::actions::physical_target::tests::fake::{FakeWorld, check_of, deadline, not_delivered};
use crate::system::process::process_facts::ProcessFacts;

const PID: u32 = 4242;
const OTHER: u32 = 99;
const INSTANCE: &str = "boot:100";

struct Keys<'a> {
    physical: &'a FakeWorld,
    focused: RefCell<VecDeque<Result<Option<WindowInfo>, AdapterError>>>,
    active: Option<u32>,
    lookup: Lookup,
    changes_after_send: bool,
    reads: RefCell<Vec<&'static str>>,
    lookups: Cell<u32>,
    stopped: bool,
}

fn facts(instance: &str) -> ProcessFacts {
    ProcessFacts {
        executable: None,
        comm: "app".to_owned(),
        exe_basename: None,
        instance: instance.to_owned(),
    }
}

impl<'a> Keys<'a> {
    fn owning(physical: &'a FakeWorld) -> Self {
        Self {
            physical,
            focused: RefCell::new(VecDeque::from([Ok(Some(window(PID, "target")))])),
            active: Some(PID),
            lookup: Lookup::Found(facts(INSTANCE)),
            changes_after_send: false,
            reads: RefCell::new(Vec::new()),
            lookups: Cell::new(0),
            stopped: false,
        }
    }

    fn set_focused(&self, pid: Option<u32>) {
        *self.focused.borrow_mut() = VecDeque::from([Ok(pid.map(|pid| window(pid, "target")))]);
    }

    fn read_count(&self, name: &str) -> usize {
        self.reads
            .borrow()
            .iter()
            .filter(|read| **read == name)
            .count()
    }
}

impl KeyWorld for Keys<'_> {
    fn stopped(&self, _pid: u32) -> bool {
        self.stopped
    }

    fn lookup(&self, _pid: u32) -> Lookup {
        self.lookups.set(self.lookups.get() + 1);
        if self.changes_after_send && self.physical.count("sent") > 0 {
            return Lookup::Found(facts("boot:other"));
        }
        self.lookup.clone()
    }

    fn focused_window(
        &self,
        _pid: u32,
        _deadline: Deadline,
    ) -> Result<Option<WindowInfo>, AdapterError> {
        self.reads.borrow_mut().push("focused");
        let mut reads = self.focused.borrow_mut();
        if reads.len() > 1 {
            reads.pop_front().unwrap()
        } else {
            reads.front().unwrap().clone()
        }
    }

    fn active_client_pid(&self, _deadline: Deadline) -> Option<u32> {
        self.reads.borrow_mut().push("active");
        self.active
    }
}

fn window(pid: u32, id: &str) -> WindowInfo {
    WindowInfo {
        id: id.into(),
        title: id.into(),
        app: "app".into(),
        pid: ProcessId::new(pid),
        process_instance: Some(INSTANCE.into()),
        bounds: None,
        state: Default::default(),
    }
}

fn process() -> ProcessIdentity {
    ProcessIdentity::new(ProcessId::new(PID), INSTANCE)
}

fn combo() -> KeyCombo {
    KeyCombo {
        key: "n".to_owned(),
        modifiers: Vec::new(),
    }
}

fn press(
    physical: &FakeWorld,
    keys: &Keys<'_>,
    policy: InteractionPolicy,
) -> Result<ActionResult, AdapterError> {
    press_in(Press {
        physical,
        keys,
        process: &process(),
        window: None,
        combo: &combo(),
        policy,
        deadline: deadline(),
    })
}

#[test]
fn the_active_owner_gets_one_synthesis_under_headless_and_headed_policy() {
    for policy in [InteractionPolicy::headless(), InteractionPolicy::headed()] {
        let physical = FakeWorld::x11();
        let keys = Keys::owning(&physical);
        let result = press(&physical, &keys, policy).expect("the owner of the active window");
        assert_eq!(physical.count("sent"), 1);
        assert_eq!(
            result.disposition(),
            DeliverySemantics::delivered_unverified()
        );
        assert_eq!(result.steps[0].label(), "XTEST.press_key");
        assert_eq!(result.steps[0].verified(), Some(false));
    }
}

#[test]
fn a_popup_grab_in_another_app_leaves_the_frame_inactive_and_nothing_is_sent() {
    let physical = FakeWorld::x11();
    let keys = Keys::owning(&physical);
    keys.set_focused(None);
    let error = press(&physical, &keys, InteractionPolicy::headed()).unwrap_err();
    assert_eq!(check_of(&error).as_deref(), Some("window_active"));
    assert!(not_delivered(&error));
    assert!(physical.sent_nothing());
}

#[test]
fn another_application_owning_either_active_measure_gets_no_keys() {
    for (focused, active, cause) in [
        (Some(OTHER), Some(PID), "other_application"),
        (Some(PID), Some(OTHER), "display_active_window"),
    ] {
        let physical = FakeWorld::x11();
        let mut keys = Keys::owning(&physical);
        keys.set_focused(focused);
        keys.active = active;
        let error = press(&physical, &keys, InteractionPolicy::headed()).unwrap_err();
        assert_eq!(check_of(&error).as_deref(), Some("window_active"));
        assert_eq!(error.details.as_ref().unwrap()["cause"], cause);
        assert!(not_delivered(&error));
        assert!(physical.sent_nothing());
    }
}

#[test]
fn a_window_with_no_known_owner_on_the_display_is_not_the_target() {
    let physical = FakeWorld::x11();
    let mut keys = Keys::owning(&physical);
    keys.active = None;
    let error = press(&physical, &keys, InteractionPolicy::headed()).unwrap_err();
    assert_eq!(check_of(&error).as_deref(), Some("window_active"));
    assert_eq!(
        error.details.as_ref().unwrap()["cause"],
        "display_active_window"
    );
    assert!(not_delivered(&error));
    assert!(physical.sent_nothing());
}

#[test]
fn on_wayland_the_gate_is_the_frame_alone() {
    let physical = FakeWorld::wayland();
    let mut keys = Keys::owning(&physical);
    keys.active = None;
    let result = press(&physical, &keys, InteractionPolicy::headless()).expect("frame active");
    assert_eq!(result.steps[0].label(), "RemoteDesktop.press_key");
    assert_eq!(keys.read_count("active"), 0);
    assert_eq!(physical.count("sent"), 1);

    let inactive = FakeWorld::wayland();
    let keys = Keys::owning(&inactive);
    keys.set_focused(Some(OTHER));
    press(&inactive, &keys, InteractionPolicy::headed()).unwrap_err();
    assert!(inactive.sent_nothing());
}

#[test]
fn an_inactive_wayland_press_offers_manual_focus_then_a_supported_retry() {
    let physical = FakeWorld::wayland();
    let keys = Keys::owning(&physical);
    keys.set_focused(None);
    let error = press(&physical, &keys, InteractionPolicy::headless()).unwrap_err();
    assert_eq!(error.code, ErrorCode::ActionFailed);
    assert_eq!(error.details.as_ref().unwrap()["cause"], "frame_not_active");
    assert_eq!(error.disposition, DeliverySemantics::not_delivered());
    assert!(physical.sent_nothing());
    let hint = error.suggestion.as_deref().unwrap();
    assert!(
        hint.contains("bring the target window to the front yourself"),
        "{hint}"
    );
    assert!(
        hint.contains("global press without --app, --window-id or --headed"),
        "{hint}"
    );

    crate::input::physical::target_keyboard::press_key_global_steps(
        &physical,
        &combo(),
        deadline(),
    )
    .unwrap();
    assert_eq!(physical.count("sent"), 1);
}

#[test]
fn a_background_target_fails_by_policy_and_neither_case_calls_synthesis() {
    for policy in [InteractionPolicy::headed(), InteractionPolicy::headless()] {
        let physical = FakeWorld::x11();
        let mut keys = Keys::owning(&physical);
        keys.set_focused(Some(OTHER));
        keys.active = Some(OTHER);
        let error = press(&physical, &keys, policy).unwrap_err();
        assert_eq!(error.code, ErrorCode::ActionFailed);
        assert_eq!(check_of(&error).as_deref(), Some("window_active"));
        assert_eq!(
            error.details.as_ref().unwrap()["cause"],
            "display_active_window"
        );
        assert!(not_delivered(&error));
        assert!(physical.sent_nothing());
    }
}

#[test]
fn a_token_that_changed_before_synthesis_is_refused_with_nothing_read_or_sent() {
    for lookup in [Lookup::Found(facts("boot:other")), Lookup::Gone] {
        let physical = FakeWorld::x11();
        let mut keys = Keys::owning(&physical);
        keys.lookup = lookup;
        let error = press(&physical, &keys, InteractionPolicy::headed()).unwrap_err();
        assert_eq!(error.code, ErrorCode::AppUnresponsive);
        assert!(not_delivered(&error));
        assert!(physical.sent_nothing());
        assert_eq!(keys.read_count("focused"), 0);
    }
}

#[test]
fn a_token_that_changed_after_synthesis_is_a_delivered_unverified_error() {
    let physical = FakeWorld::x11();
    let mut keys = Keys::owning(&physical);
    keys.changes_after_send = true;
    let error = press(&physical, &keys, InteractionPolicy::headed()).unwrap_err();
    assert_eq!(error.code, ErrorCode::AppUnresponsive);
    assert_eq!(error.disposition, DeliverySemantics::delivered_unverified());
    assert_eq!(physical.count("sent"), 1);
}

#[test]
fn an_unreadable_process_does_not_end_the_press() {
    let physical = FakeWorld::x11();
    let mut keys = Keys::owning(&physical);
    keys.lookup = Lookup::Unreadable;
    press(&physical, &keys, InteractionPolicy::headed()).expect("unreadable is not changed");
    assert_eq!(physical.count("sent"), 1);
}

#[test]
fn a_stopped_target_is_unresponsive_and_nothing_is_synthesised() {
    let physical = FakeWorld::x11();
    let mut keys = Keys::owning(&physical);
    keys.stopped = true;
    let error = press(&physical, &keys, InteractionPolicy::headed()).expect_err("stopped");
    assert_eq!(error.code, ErrorCode::AppUnresponsive);
    assert_eq!(error.disposition, DeliverySemantics::not_delivered());
    assert_eq!(physical.count("sent"), 0);
}

#[test]
fn window_scoped_press_rechecks_exact_focus_before_synthesis() {
    for wayland in [false, true] {
        for changed in [false, true] {
            let physical = if wayland {
                FakeWorld::wayland()
            } else {
                FakeWorld::x11()
            };
            let keys = Keys::owning(&physical);
            if changed {
                *keys.focused.borrow_mut() = VecDeque::from([
                    Ok(Some(window(PID, "target"))),
                    Ok(Some(window(PID, "sibling"))),
                ]);
            }
            let result = press_in(Press {
                physical: &physical,
                keys: &keys,
                process: &process(),
                window: Some(&window(PID, "target")),
                combo: &combo(),
                policy: InteractionPolicy::headless(),
                deadline: deadline(),
            });
            if changed {
                let error = result.unwrap_err();
                assert_eq!(error.code, ErrorCode::StaleRef);
                assert!(not_delivered(&error));
                assert!(physical.sent_nothing());
            } else {
                assert!(result.is_ok());
                assert_eq!(physical.count("sent"), 1);
            }
        }
    }
}

#[test]
fn window_scoped_press_refuses_unknown_or_mismatched_focus_without_synthesis() {
    let mut recycled = window(PID, "target");
    recycled.process_instance = Some("recycled".into());
    for focus in [
        Err(AdapterError::not_supported("focused_window")),
        Ok(None),
        Ok(Some(window(PID, "sibling"))),
        Ok(Some(window(OTHER, "target"))),
        Ok(Some(recycled)),
    ] {
        let physical = FakeWorld::x11();
        let keys = Keys::owning(&physical);
        *keys.focused.borrow_mut() = VecDeque::from([focus]);
        let error = press_in(Press {
            physical: &physical,
            keys: &keys,
            process: &process(),
            window: Some(&window(PID, "target")),
            combo: &combo(),
            policy: InteractionPolicy::headless(),
            deadline: deadline(),
        })
        .unwrap_err();
        assert_eq!(error.code, ErrorCode::StaleRef);
        assert!(not_delivered(&error));
        assert!(physical.sent_nothing());
    }
}
