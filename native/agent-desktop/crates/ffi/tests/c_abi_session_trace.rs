mod common;

use agent_desktop_core::session::{
    SessionTraceMode, StartSessionOptions, start_session, trace_dir,
};
use common::{
    AdResult, ad_adapter_create_with_session, ad_adapter_destroy, ad_check_permissions,
    ad_free_string, ad_status, with_isolated_home,
};
use std::ffi::CString;
use std::fs;

fn trace_segments(session_id: &str) -> Vec<std::path::PathBuf> {
    fs::read_dir(trace_dir(session_id).unwrap())
        .unwrap()
        .flatten()
        .map(|entry| entry.path())
        .filter(|path| {
            path.extension()
                .is_some_and(|extension| extension == "jsonl")
        })
        .collect()
}

unsafe fn call_status(session_id: &str) {
    let session = CString::new(session_id).unwrap();
    let adapter = unsafe { ad_adapter_create_with_session(session.as_ptr()) };
    assert!(!adapter.is_null());
    let mut out = std::ptr::null_mut();
    let result = unsafe { ad_status(adapter, &mut out) };
    assert_eq!(result, AdResult::Ok);
    assert!(!out.is_null());
    unsafe {
        ad_free_string(out);
        ad_adapter_destroy(adapter);
    }
}

#[test]
fn traced_ffi_commands_reuse_one_process_segment_and_emit_ordered_boundaries() {
    with_isolated_home(|| {
        let manifest = start_session(StartSessionOptions {
            name: None,
            trace: SessionTraceMode::On,
            ..Default::default()
        })
        .unwrap();

        unsafe {
            call_status(&manifest.id);
            call_status(&manifest.id);
        }

        let segments = trace_segments(&manifest.id);
        assert_eq!(segments.len(), 1);
        let events: Vec<serde_json::Value> = fs::read_to_string(&segments[0])
            .unwrap()
            .lines()
            .map(|line| serde_json::from_str(line).unwrap())
            .filter(|event: &serde_json::Value| event["command"].as_str() == Some("status"))
            .collect();
        let boundaries: Vec<_> = events
            .iter()
            .filter_map(|event| event["event"].as_str())
            .filter(|event| matches!(*event, "command.start" | "command.end"))
            .collect();
        assert_eq!(
            boundaries,
            [
                "command.start",
                "command.end",
                "command.start",
                "command.end"
            ]
        );
    });
}

#[test]
fn manifestless_session_does_not_create_trace_files() {
    with_isolated_home(|| {
        let session_id = "plain-session";
        unsafe {
            let session = CString::new(session_id).unwrap();
            let adapter = ad_adapter_create_with_session(session.as_ptr());
            assert!(!adapter.is_null());
            let _ = ad_check_permissions(adapter);
            ad_adapter_destroy(adapter);
        }
        assert!(!trace_dir(session_id).unwrap().exists());
    });
}
