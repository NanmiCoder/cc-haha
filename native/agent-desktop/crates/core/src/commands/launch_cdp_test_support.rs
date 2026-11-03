use crate::adapter::{ActionOps, InputOps, ObservationOps, SystemOps};
use crate::system::launch_options::LaunchOptions;
use crate::{AdapterError, AppError, AppInfo, InteractionLease, ProcessId, RendererKind};
use std::io::{Read, Write};
use std::net::TcpListener;
use std::sync::Mutex;
use std::sync::atomic::{AtomicUsize, Ordering};

/// Mock adapter for the `--cdp` wiring: records the options `launch_app`
/// actually received, and can optionally serve a canned `/json/version`
/// response on the requested port so the endpoint-verified path is testable
/// without a real Chromium-based application. Shared by every `--cdp` test
/// module in this file's family so the mock is defined once.
pub(super) struct CdpAdapter {
    pub(super) running: Vec<AppInfo>,
    pub(super) list_apps_calls: AtomicUsize,
    pub(super) launch_app_calls: AtomicUsize,
    pub(super) serve_cdp: bool,
    pub(super) attribute_cdp_listener: bool,
    pub(super) renderer: Option<RendererKind>,
    pub(super) captured_options: Mutex<LaunchOptions>,
}

impl ObservationOps for CdpAdapter {
    fn list_apps(&self, _deadline: crate::Deadline) -> Result<Vec<AppInfo>, AdapterError> {
        self.list_apps_calls.fetch_add(1, Ordering::SeqCst);
        Ok(self.running.clone())
    }
}
impl ActionOps for CdpAdapter {}
impl InputOps for CdpAdapter {}

impl SystemOps for CdpAdapter {
    fn acquire_interaction_lease(
        &self,
        deadline: crate::Deadline,
    ) -> Result<InteractionLease, AdapterError> {
        InteractionLease::guarded(deadline, ())
    }

    fn launch_app(
        &self,
        _id: &str,
        options: &LaunchOptions,
        _lease: &InteractionLease,
    ) -> Result<crate::system::launch_result::LaunchResult, AdapterError> {
        self.launch_app_calls.fetch_add(1, Ordering::SeqCst);
        *self.captured_options.lock().unwrap() = options.clone();
        if self.serve_cdp {
            let port = options.cdp_port.expect("cdp_port resolved before launch");
            serve_fake_cdp_endpoint(port);
        }
        Ok(crate::system::launch_result::LaunchResult {
            app: "Fixture".into(),
            pid: ProcessId::new(42),
            process_instance: Some("42:1".into()),
            window: None,
            cdp: None,
            renderer: self.renderer,
            suggestion: None,
        })
    }

    fn process_owns_tcp_listener(
        &self,
        process: crate::ProcessIdentity,
        _port: u16,
        _deadline: crate::Deadline,
    ) -> Result<bool, AdapterError> {
        Ok(self.attribute_cdp_listener
            && self.serve_cdp
            && process.pid == ProcessId::new(42)
            && process.instance == "42:1")
    }
}

fn serve_fake_cdp_endpoint(port: u16) {
    let listener = TcpListener::bind(("127.0.0.1", port)).expect("port was reserved by the caller");
    std::thread::spawn(move || {
        if let Ok((mut stream, _)) = listener.accept() {
            let mut buf = [0_u8; 1024];
            let _ = stream.read(&mut buf);
            let body = format!(
                r#"{{"Browser":"Fixture/1.0","webSocketDebuggerUrl":"ws://127.0.0.1:{port}/devtools/browser/fixture"}}"#
            );
            let response = format!(
                "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\n\r\n{}",
                body.len(),
                body
            );
            let _ = stream.write_all(response.as_bytes());
        }
    });
}

pub(super) fn empty_cdp_adapter(serve_cdp: bool) -> CdpAdapter {
    CdpAdapter {
        running: Vec::new(),
        list_apps_calls: AtomicUsize::new(0),
        launch_app_calls: AtomicUsize::new(0),
        serve_cdp,
        attribute_cdp_listener: serve_cdp,
        renderer: None,
        captured_options: Mutex::new(LaunchOptions::default()),
    }
}

pub(super) fn adapter_error(error: AppError) -> AdapterError {
    match error {
        AppError::Adapter(inner) => inner,
        other => panic!("expected an adapter error, got {other:?}"),
    }
}
