use super::*;
use crate::adapter::{ActionOps, InputOps, ObservationOps, SystemOps};
use crate::{AdapterError, WindowInfo};
use std::sync::Mutex;
use std::time::Duration;

struct FocusAdapter {
    windows: Vec<WindowInfo>,
    focused_windows: Mutex<Vec<WindowInfo>>,
    focused_window_calls: Mutex<u32>,
    focused_window_supported: bool,
}

impl ObservationOps for FocusAdapter {
    fn list_windows(
        &self,
        filter: &WindowFilter,
        _deadline: crate::Deadline,
    ) -> Result<Vec<WindowInfo>, AdapterError> {
        if filter.focused_only {
            Ok(self.focused_windows.lock().unwrap().clone())
        } else {
            Ok(self.windows.clone())
        }
    }
}

impl ActionOps for FocusAdapter {}

impl InputOps for FocusAdapter {}

impl SystemOps for FocusAdapter {
    crate::adapter::guarded_interaction_lease!();

    fn focus_window(
        &self,
        _win: &WindowInfo,
        _lease: &crate::InteractionLease,
    ) -> Result<(), AdapterError> {
        Ok(())
    }

    fn focused_window(
        &self,
        _deadline: crate::Deadline,
    ) -> Result<Option<WindowInfo>, AdapterError> {
        *self.focused_window_calls.lock().unwrap() += 1;
        if !self.focused_window_supported {
            return Err(AdapterError::not_supported("focused_window"));
        }
        let mut focused = self.focused_windows.lock().unwrap();
        if focused.len() > 1 {
            Ok(Some(focused.remove(0)))
        } else {
            Ok(focused.first().cloned())
        }
    }
}

fn window(id: &str, focused: bool) -> WindowInfo {
    WindowInfo {
        id: id.into(),
        title: "Main".into(),
        app: "TextEdit".into(),
        pid: crate::ProcessId::new(42),
        process_instance: Some("test-instance".into()),
        bounds: None,
        state: crate::WindowState {
            is_focused: focused,
            ..Default::default()
        },
    }
}

#[test]
fn reports_focused_window_after_os_confirms_focus() {
    let target = window("w1", false);
    let adapter = FocusAdapter {
        windows: vec![target.clone()],
        focused_windows: Mutex::new(vec![window("w1", true)]),
        focused_window_calls: Mutex::new(0),
        focused_window_supported: true,
    };

    let value = execute(
        FocusWindowArgs {
            window_id: Some(target.id),
            app: None,
            title: None,
        },
        &adapter,
    )
    .unwrap();

    assert_eq!(value["focused"]["id"], "w1");
    assert_eq!(value["focused"]["is_focused"], true);
    assert_eq!(*adapter.focused_window_calls.lock().unwrap(), 2);
}

#[test]
fn errors_when_focus_does_not_settle_on_requested_window() {
    let target = window("w1", false);
    let adapter = FocusAdapter {
        windows: vec![target.clone()],
        focused_windows: Mutex::new(Vec::new()),
        focused_window_calls: Mutex::new(0),
        focused_window_supported: true,
    };

    let err = execute(
        FocusWindowArgs {
            window_id: Some(target.id),
            app: None,
            title: None,
        },
        &adapter,
    )
    .unwrap_err();

    assert_eq!(err.code(), "ACTION_FAILED");
}

#[test]
fn falls_back_to_focused_window_list_when_direct_observation_is_unsupported() {
    let target = window("w1", false);
    let adapter = FocusAdapter {
        windows: vec![target.clone()],
        focused_windows: Mutex::new(vec![window("w1", true)]),
        focused_window_calls: Mutex::new(0),
        focused_window_supported: false,
    };

    let value = execute(
        FocusWindowArgs {
            window_id: Some(target.id),
            app: None,
            title: None,
        },
        &adapter,
    )
    .unwrap();

    assert_eq!(value["focused"]["id"], "w1");
    assert_eq!(*adapter.focused_window_calls.lock().unwrap(), 2);
}

#[test]
fn focus_confirmation_resets_after_transient_wrong_window() {
    let target = window("w1", false);
    let adapter = FocusAdapter {
        windows: vec![target.clone()],
        focused_windows: Mutex::new(vec![
            window("w1", true),
            window("w2", true),
            window("w1", true),
            window("w1", true),
        ]),
        focused_window_calls: Mutex::new(0),
        focused_window_supported: true,
    };

    let value = crate::system::window_focus::wait_for_focused_window_with_poll_interval(
        &adapter,
        &target.id,
        None,
        Duration::ZERO,
        crate::Deadline::standard().unwrap(),
    )
    .unwrap();

    assert_eq!(value.id, "w1");
    assert_eq!(*adapter.focused_window_calls.lock().unwrap(), 4);
}

#[test]
fn app_filter_results_are_not_discarded_by_display_name() {
    let mut target = window("w1", false);
    target.app = "WhatsApp".into();
    let mut focused = target.clone();
    focused.state.is_focused = true;
    let adapter = FocusAdapter {
        windows: vec![target],
        focused_windows: Mutex::new(vec![focused]),
        focused_window_calls: Mutex::new(0),
        focused_window_supported: true,
    };

    let value = execute(
        FocusWindowArgs {
            window_id: None,
            app: Some("net.whatsapp.WhatsApp".into()),
            title: None,
        },
        &adapter,
    )
    .unwrap();

    assert_eq!(value["focused"]["id"], "w1");
}
