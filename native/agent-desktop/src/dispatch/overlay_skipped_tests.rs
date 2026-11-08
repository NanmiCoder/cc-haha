use super::log;
use agent_desktop_core::{AdapterError, ErrorCode};
use std::sync::{Arc, Mutex};

#[derive(Clone, Default)]
struct Sink(Arc<Mutex<Vec<u8>>>);

impl std::io::Write for Sink {
    fn write(&mut self, bytes: &[u8]) -> std::io::Result<usize> {
        self.0.lock().unwrap().extend_from_slice(bytes);
        Ok(bytes.len())
    }

    fn flush(&mut self) -> std::io::Result<()> {
        Ok(())
    }
}

fn logged(error: &AdapterError) -> String {
    let sink = Sink::default();
    let writer = sink.clone();
    let subscriber = tracing_subscriber::fmt()
        .with_max_level(tracing::Level::WARN)
        .with_writer(move || writer.clone())
        .finish();
    tracing::subscriber::with_default(subscriber, || log(error));
    let bytes = sink.0.lock().unwrap().clone();
    String::from_utf8(bytes).unwrap()
}

#[test]
fn a_platform_without_an_overlay_leaves_standard_error_empty() {
    let error = AdapterError::new(ErrorCode::PlatformNotSupported, "no overlay");
    assert!(logged(&error).is_empty());
}

#[test]
fn an_unexpected_overlay_failure_is_still_warned_about() {
    let error = AdapterError::new(ErrorCode::ActionFailed, "broken");
    assert!(logged(&error).contains("cursor overlay lifecycle update was skipped"));
}
