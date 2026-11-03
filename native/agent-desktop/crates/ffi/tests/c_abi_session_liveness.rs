mod common;

use agent_desktop_core::session::{
    GcOptions, SessionTraceMode, StartSessionOptions, gc, start_session, write_manifest,
};
use common::{ad_adapter_create_with_session, ad_adapter_destroy, with_isolated_home};
use std::ffi::CString;
use std::time::Duration;

/// Runs alone in its own process for env-var hygiene: the isolated HOME
/// swap is process-wide, so a dedicated process keeps it from interleaving
/// with adapter state other suites establish. The historical gc hazard is
/// gone — on Windows the installed `WindowsPrivateFile` now scopes its temp
/// lease to each atomic write, so no process-lifetime directory handle
/// lingers inside the session directory and same-process gc removal (as
/// exercised below) succeeds against everything this process wrote.
#[test]
fn session_scoped_adapter_holds_liveness_until_destroyed() {
    with_isolated_home(|| {
        let mut manifest = start_session(StartSessionOptions {
            name: None,
            trace: SessionTraceMode::Off,
            ..Default::default()
        })
        .unwrap();
        manifest.created_at = 0;
        write_manifest(&manifest).unwrap();
        let session = CString::new(manifest.id.as_str()).unwrap();
        let adapter = unsafe { ad_adapter_create_with_session(session.as_ptr()) };
        assert!(!adapter.is_null());

        let retained = gc(GcOptions {
            ended_only: false,
            older_than: Some(Duration::ZERO),
        })
        .unwrap();
        assert!(!retained.removed.contains(&manifest.id));

        unsafe { ad_adapter_destroy(adapter) };
        let removed = gc(GcOptions {
            ended_only: false,
            older_than: Some(Duration::ZERO),
        })
        .unwrap();
        assert!(removed.removed.contains(&manifest.id));
    });
}
