//! Scoped forwarding of Rust tracing events to a foreign callback.
//!
//! A callback is active only while an `ad_*` entrypoint executes on the
//! calling thread. The FFI never installs or replaces the host process's
//! global tracing subscriber.

use std::cell::Cell;
use std::ffi::{CString, c_char};
use std::panic::{AssertUnwindSafe, catch_unwind};
use std::sync::{Mutex, MutexGuard};

use agent_desktop_core::sanitize_trace_value;
use serde_json::{Map, Value};
use tracing::field::{Field, Visit};
use tracing::{Dispatch, Event, Level, Subscriber};
use tracing_subscriber::Layer;
use tracing_subscriber::layer::SubscriberExt;

use crate::error::AdResult;

static CALLBACK: Mutex<Option<unsafe extern "C" fn(level: i32, msg: *const c_char)>> =
    Mutex::new(None);

thread_local! {
    static IN_CALLBACK: Cell<bool> = const { Cell::new(false) };
}

struct CallbackGuard;

impl Drop for CallbackGuard {
    fn drop(&mut self) {
        IN_CALLBACK.set(false);
    }
}

struct FieldCollector {
    map: Map<String, Value>,
}

impl Visit for FieldCollector {
    fn record_str(&mut self, field: &Field, value: &str) {
        self.map
            .insert(field.name().to_owned(), Value::String(value.to_owned()));
    }

    fn record_debug(&mut self, field: &Field, value: &dyn std::fmt::Debug) {
        self.map
            .insert(field.name().to_owned(), Value::String(format!("{value:?}")));
    }

    fn record_i64(&mut self, field: &Field, value: i64) {
        self.map.insert(field.name().to_owned(), Value::from(value));
    }

    fn record_u64(&mut self, field: &Field, value: u64) {
        self.map.insert(field.name().to_owned(), Value::from(value));
    }

    fn record_bool(&mut self, field: &Field, value: bool) {
        self.map.insert(field.name().to_owned(), Value::Bool(value));
    }
}

struct CallbackLayer;

impl<S: Subscriber> Layer<S> for CallbackLayer {
    fn on_event(&self, event: &Event<'_>, _ctx: tracing_subscriber::layer::Context<'_, S>) {
        if IN_CALLBACK.get() {
            return;
        }
        let Some(callback) = current_callback() else {
            return;
        };
        let message = catch_unwind(AssertUnwindSafe(|| format_event(event)))
            .ok()
            .flatten();
        let Some(message) = message else {
            return;
        };
        IN_CALLBACK.set(true);
        let _guard = CallbackGuard;
        unsafe { callback(level_number(event.metadata().level()), message.as_ptr()) };
    }
}

fn callback_slot()
-> MutexGuard<'static, Option<unsafe extern "C" fn(level: i32, msg: *const c_char)>> {
    match CALLBACK.lock() {
        Ok(guard) => guard,
        Err(poisoned) => poisoned.into_inner(),
    }
}

fn current_callback() -> Option<unsafe extern "C" fn(level: i32, msg: *const c_char)> {
    *callback_slot()
}

fn level_number(level: &Level) -> i32 {
    match *level {
        Level::ERROR => 1,
        Level::WARN => 2,
        Level::INFO => 3,
        Level::DEBUG => 4,
        Level::TRACE => 5,
    }
}

fn format_event(event: &Event<'_>) -> Option<CString> {
    let mut collector = FieldCollector { map: Map::new() };
    event.record(&mut collector);
    let sanitized = sanitize_trace_value(Value::Object(collector.map));
    CString::new(serde_json::to_string(&sanitized).ok()?).ok()
}

pub(crate) fn with_dispatch<R>(body: impl FnOnce() -> R) -> R {
    if current_callback().is_none() {
        return body();
    }
    let subscriber = tracing_subscriber::registry().with(CallbackLayer);
    let dispatch = Dispatch::new(subscriber);
    tracing::dispatcher::with_default(&dispatch, body)
}

/// Registers or clears the callback used for events emitted synchronously
/// inside later `ad_*` calls on the same thread.
///
/// The callback may be invoked concurrently by different host threads. The
/// message pointer is valid only until the callback returns. The callback must
/// not unwind across this C ABI boundary; C++ exceptions and Rust panics must
/// be caught inside the callback. Violating that contract may abort the host.
#[unsafe(no_mangle)]
pub extern "C" fn ad_set_log_callback(
    callback: Option<unsafe extern "C" fn(level: i32, msg: *const c_char)>,
) -> AdResult {
    crate::ffi_try::trap_panic(|| {
        *callback_slot() = callback;
        AdResult::Ok
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::ffi::CStr;
    use std::sync::Mutex;

    static MESSAGES: Mutex<Vec<String>> = Mutex::new(Vec::new());
    static LOG_TEST_LOCK: Mutex<()> = Mutex::new(());

    unsafe extern "C" fn record(_level: i32, message: *const c_char) {
        let message = unsafe { CStr::from_ptr(message) }
            .to_string_lossy()
            .into_owned();
        MESSAGES.lock().unwrap().push(message);
    }

    #[test]
    fn scoped_dispatch_delivers_and_redacts() {
        let _guard = LOG_TEST_LOCK.lock().unwrap();
        MESSAGES.lock().unwrap().clear();
        assert_eq!(ad_set_log_callback(Some(record)), AdResult::Ok);
        with_dispatch(|| {
            tracing::error!(
                password = "secret",
                key = "Control+Shift+W",
                operation = "login"
            )
        });
        assert_eq!(ad_set_log_callback(None), AdResult::Ok);

        let messages = MESSAGES.lock().unwrap();
        assert_eq!(messages.len(), 1);
        assert!(messages[0].contains("redacted"));
        assert!(messages[0].contains("login"));
        assert!(!messages[0].contains("secret"));
        assert!(!messages[0].contains("Control+Shift+W"));
    }

    #[test]
    fn callback_does_not_capture_outside_scope() {
        let _guard = LOG_TEST_LOCK.lock().unwrap();
        MESSAGES.lock().unwrap().clear();
        assert_eq!(ad_set_log_callback(Some(record)), AdResult::Ok);
        tracing::error!(operation = "outside");
        assert_eq!(ad_set_log_callback(None), AdResult::Ok);
        assert!(MESSAGES.lock().unwrap().is_empty());
    }
}
