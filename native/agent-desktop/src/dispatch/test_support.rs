use std::path::PathBuf;
use std::sync::Mutex;
use std::sync::atomic::{AtomicU64, Ordering};

use agent_desktop_core::{ActionOps, AdapterError, ErrorCode, InputOps, ObservationOps, SystemOps};

static HOME_LOCK: Mutex<()> = Mutex::new(());
static HOME_ID: AtomicU64 = AtomicU64::new(1);

/// Takes the lock back from a poisoned mutex rather than panicking on it.
/// A test that fails while holding this would otherwise decide every later
/// test in the process: they would report a poisoned lock instead of their
/// own result, and the first failure's cause would be the only one visible.
pub(crate) struct HomeGuard {
    lock: Option<std::sync::MutexGuard<'static, ()>>,
    previous: Option<std::ffi::OsString>,
    path: PathBuf,
}

impl HomeGuard {
    pub(crate) fn new() -> Self {
        let lock = HOME_LOCK
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        let path = std::env::temp_dir().join(format!(
            "agent-desktop-dispatch-test-{}-{}",
            std::process::id(),
            HOME_ID.fetch_add(1, Ordering::Relaxed)
        ));
        std::fs::create_dir_all(&path).unwrap();
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o700)).unwrap();
        }
        let previous = std::env::var_os("AGENT_DESKTOP_HOME");
        unsafe { std::env::set_var("AGENT_DESKTOP_HOME", &path) };
        Self {
            lock: Some(lock),
            previous,
            path,
        }
    }

    pub(crate) fn path(&self) -> &std::path::Path {
        &self.path
    }
}

impl Drop for HomeGuard {
    fn drop(&mut self) {
        match self.previous.take() {
            Some(previous) => unsafe { std::env::set_var("AGENT_DESKTOP_HOME", previous) },
            None => unsafe { std::env::remove_var("AGENT_DESKTOP_HOME") },
        }
        self.lock.take();
    }
}

/// Starts a session with tracing off and enables the cursor overlay on it,
/// the fixed setup every overlay-lifecycle test builds on before it varies
/// the one thing the test actually checks.
pub(crate) fn started_overlay_session() -> agent_desktop_core::session::SessionManifest {
    let manifest = agent_desktop_core::session::start_session(
        agent_desktop_core::session::StartSessionOptions {
            trace: agent_desktop_core::session::SessionTraceMode::Off,
            artifacts: agent_desktop_core::session::ArtifactsMode::Events,
            name: None,
        },
    )
    .unwrap();
    agent_desktop_core::session::set_cursor_overlay(
        &manifest.id,
        agent_desktop_core::CursorOverlayConfig::enabled(None, 6).unwrap(),
    )
    .unwrap();
    manifest
}

pub(crate) struct FailingOverlayAdapter;

impl ObservationOps for FailingOverlayAdapter {}
impl ActionOps for FailingOverlayAdapter {}
impl InputOps for FailingOverlayAdapter {}

impl SystemOps for FailingOverlayAdapter {
    fn update_cursor_overlay(
        &self,
        _control: &agent_desktop_core::CursorOverlayControl,
    ) -> Result<(), AdapterError> {
        Err(AdapterError::new(
            ErrorCode::ActionFailed,
            "overlay teardown failed",
        ))
    }
}
