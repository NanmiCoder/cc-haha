use super::*;
use std::sync::{Arc, Mutex};
use tracing::field::{Field, Visit};
use tracing::span::{Attributes, Id, Record};
use tracing::{Event, Metadata, Subscriber};

struct LogCapture(Arc<Mutex<Vec<String>>>);

impl Subscriber for LogCapture {
    fn enabled(&self, _metadata: &Metadata<'_>) -> bool {
        true
    }

    fn new_span(&self, _attributes: &Attributes<'_>) -> Id {
        Id::from_u64(1)
    }

    fn record(&self, _span: &Id, _values: &Record<'_>) {}

    fn record_follows_from(&self, _span: &Id, _follows: &Id) {}

    fn event(&self, event: &Event<'_>) {
        let mut fields = CapturedFields::default();
        event.record(&mut fields);
        self.0.lock().unwrap().push(fields.0);
    }

    fn enter(&self, _span: &Id) {}

    fn exit(&self, _span: &Id) {}
}

#[derive(Default)]
struct CapturedFields(String);

impl Visit for CapturedFields {
    fn record_debug(&mut self, field: &Field, value: &dyn std::fmt::Debug) {
        self.0.push_str(&format!("{}={value:?};", field.name()));
    }

    fn record_str(&mut self, field: &Field, value: &str) {
        self.0.push_str(&format!("{}={value};", field.name()));
    }
}

#[test]
fn snapshot_completion_log_omits_private_app_and_window_names() {
    let args = base_args();
    let mut result = crate::snapshot::build(
        &WaitSnapshotAdapter,
        &tree_options(&args),
        Some("PrivateApp-7391"),
        None,
        crate::Deadline::standard().unwrap(),
    )
    .unwrap();
    result.window.app = "PrivateApp-7391".into();
    result.window.title = "PrivateWindow-1842".into();
    let events = Arc::new(Mutex::new(Vec::new()));
    let subscriber = LogCapture(events.clone());

    let output = tracing::subscriber::with_default(subscriber, || format_result(result).unwrap());

    let events = events.lock().unwrap();
    assert_eq!(events.len(), 1);
    assert!(events[0].contains("snapshot complete"));
    assert!(events[0].contains("refs=2"));
    assert!(!events[0].contains("PrivateApp-7391"));
    assert!(!events[0].contains("PrivateWindow-1842"));
    assert_eq!(output["app"], "PrivateApp-7391");
    assert_eq!(output["window"]["title"], "PrivateWindow-1842");
}
