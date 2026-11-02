use agent_desktop_core::{
    ActionOps, AdapterError, Deadline, ErrorCode, InputOps, ObservationOps, SystemOps, WindowInfo,
    WindowState,
};

#[path = "../support/noop_ops.rs"]
mod noop_ops;

struct WindowIdentityAdapter {
    windows: Vec<WindowInfo>,
}

impl ObservationOps for WindowIdentityAdapter {}

impl ActionOps for WindowIdentityAdapter {}

impl InputOps for WindowIdentityAdapter {}

impl SystemOps for WindowIdentityAdapter {
    fn resolve_window_strict(
        &self,
        win: &WindowInfo,
        _deadline: Deadline,
    ) -> Result<WindowInfo, AdapterError> {
        let live = self
            .windows
            .iter()
            .find(|candidate| candidate.id == win.id)
            .cloned()
            .ok_or_else(|| {
                AdapterError::new(
                    ErrorCode::WindowNotFound,
                    format!("Window '{}' not found", win.id),
                )
            })?;
        if live.pid != win.pid || live.process_instance != win.process_instance {
            return Err(AdapterError::new(
                ErrorCode::WindowNotFound,
                format!("Window '{}' identity mismatch", win.id),
            ));
        }
        if !win.title.is_empty() && live.title != win.title {
            return Err(AdapterError::new(
                ErrorCode::WindowNotFound,
                format!("Window '{}' identity mismatch", win.id),
            ));
        }
        Ok(live)
    }
}

fn untitled(id: &str, pid: u32) -> WindowInfo {
    WindowInfo {
        id: id.into(),
        title: "Untitled".into(),
        app: "TextEdit".into(),
        pid: agent_desktop_core::ProcessId::new(pid),
        process_instance: Some(format!("contract-process-{pid}")),
        bounds: None,
        state: WindowState::default(),
    }
}

#[test]
fn recycled_id_with_same_pid_and_new_process_instance_fails_closed() {
    let mut live = untitled("w-100", 10);
    live.process_instance = Some("replacement-process".into());
    let adapter = WindowIdentityAdapter {
        windows: vec![live],
    };
    let target = untitled("w-100", 10);

    let err = adapter
        .resolve_window_strict(&target, Deadline::standard().unwrap())
        .unwrap_err();

    assert_eq!(err.code, ErrorCode::WindowNotFound);
}

#[test]
fn resolve_window_strict_default_is_not_supported() {
    let err = noop_ops::NoopAdapter
        .resolve_window_strict(&untitled("w-1", 10), Deadline::standard().unwrap())
        .unwrap_err();

    assert_eq!(err.code, ErrorCode::PlatformNotSupported);
}
