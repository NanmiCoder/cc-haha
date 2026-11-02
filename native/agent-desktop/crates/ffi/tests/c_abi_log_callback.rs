mod common;

use common::{AdResult, CStr, ad_free_string, ad_set_log_callback, ad_snapshot, with_adapter};
use std::os::raw::c_char;
use std::sync::Mutex;

struct Delivery {
    level: i32,
    message: String,
}

static RECORDER: Mutex<Vec<Delivery>> = Mutex::new(Vec::new());
static LOG_TEST_LOCK: Mutex<()> = Mutex::new(());

unsafe extern "C" fn recorder_cb(level: i32, msg: *const c_char) {
    if msg.is_null() {
        return;
    }
    let message = unsafe { CStr::from_ptr(msg) }
        .to_string_lossy()
        .into_owned();
    if let Ok(mut guard) = RECORDER.lock() {
        guard.push(Delivery { level, message });
    }
}

fn clear_recorder() {
    if let Ok(mut g) = RECORDER.lock() {
        g.clear();
    }
}

fn drain_recorder() -> Vec<Delivery> {
    RECORDER
        .lock()
        .map(|mut g| g.drain(..).collect())
        .unwrap_or_default()
}

fn require_snapshot_event(deliveries: &[Delivery]) -> &Delivery {
    deliveries
        .iter()
        .find(|d| d.message.contains("tree: snapshot"))
        .unwrap_or_else(|| {
            let seen: Vec<String> = deliveries
                .iter()
                .map(|d| d.message.chars().take(80).collect())
                .collect();
            panic!("no \"tree: snapshot\" event delivered; saw {seen:?}")
        })
}

fn emit_scoped_ffi_event() {
    with_adapter(|adapter| unsafe {
        let mut out = std::ptr::null_mut();
        let _ = ad_snapshot(adapter, std::ptr::null(), 0, 1, false, false, &mut out);
        ad_free_string(out);
    });
}

#[test]
fn log_callback_register_delivers_event() {
    let _guard = LOG_TEST_LOCK.lock().unwrap();
    clear_recorder();

    unsafe {
        let rc = ad_set_log_callback(Some(recorder_cb));
        assert_eq!(rc, AdResult::Ok, "register must succeed");
    }

    emit_scoped_ffi_event();

    let deliveries = drain_recorder();
    let d = require_snapshot_event(&deliveries);
    assert_eq!(d.level, 4, "DEBUG maps to level 4");
    assert!(!d.message.is_empty(), "message must be non-empty");

    unsafe {
        let _ = ad_set_log_callback(None);
    }
}

#[test]
fn log_callback_spawned_thread_does_not_panic() {
    let _guard = LOG_TEST_LOCK.lock().unwrap();
    clear_recorder();

    unsafe {
        let rc = ad_set_log_callback(Some(recorder_cb));
        assert_eq!(rc, AdResult::Ok);
    }

    let handle = std::thread::spawn(emit_scoped_ffi_event);
    handle.join().expect("spawned thread must not panic");

    let deliveries = drain_recorder();
    require_snapshot_event(&deliveries);

    unsafe {
        let _ = ad_set_log_callback(None);
    }
}

#[test]
fn log_callback_null_unregisters() {
    let _guard = LOG_TEST_LOCK.lock().unwrap();
    clear_recorder();

    unsafe {
        let _ = ad_set_log_callback(Some(recorder_cb));
        let rc = ad_set_log_callback(None);
        assert_eq!(rc, AdResult::Ok, "NULL unregister must succeed");
    }
    clear_recorder();

    emit_scoped_ffi_event();

    let deliveries = drain_recorder();
    assert!(
        deliveries.is_empty(),
        "no deliveries expected after NULL unregister, got {}",
        deliveries.len()
    );
}

#[test]
fn log_callback_does_not_capture_host_global_events() {
    let _guard = LOG_TEST_LOCK.lock().unwrap();
    clear_recorder();

    unsafe {
        let rc = ad_set_log_callback(Some(recorder_cb));
        assert_eq!(rc, AdResult::Ok);
    }

    tracing::error!(operation = "host_global_event");

    let deliveries = drain_recorder();
    assert!(deliveries.is_empty());

    unsafe {
        let _ = ad_set_log_callback(None);
    }
}

#[test]
fn log_callback_re_register_is_ok() {
    let _guard = LOG_TEST_LOCK.lock().unwrap();
    clear_recorder();

    unsafe {
        assert_eq!(ad_set_log_callback(Some(recorder_cb)), AdResult::Ok);
        assert_eq!(ad_set_log_callback(None), AdResult::Ok);
        assert_eq!(ad_set_log_callback(Some(recorder_cb)), AdResult::Ok);
        assert_eq!(ad_set_log_callback(None), AdResult::Ok);
    }
}
