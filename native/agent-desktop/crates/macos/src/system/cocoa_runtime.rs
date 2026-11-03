use agent_desktop_core::{AdapterError, ErrorCode};
use std::sync::OnceLock;

pub fn ensure_cocoa_multithreaded() -> Result<(), AdapterError> {
    static INITIALIZED: OnceLock<Result<(), String>> = OnceLock::new();
    INITIALIZED
        .get_or_init(crate::system::appkit_bridge::ensure_cocoa_multithreaded)
        .clone()
        .map_err(|message| {
            AdapterError::new(ErrorCode::AppUnresponsive, message).with_details(serde_json::json!({
                "kind": "cocoa_runtime_initialization",
                "retryable": false,
            }))
        })
}

#[cfg(test)]
mod tests {
    #[test]
    fn initializes_once_from_a_worker_thread() {
        let first = std::thread::spawn(super::ensure_cocoa_multithreaded)
            .join()
            .expect("worker thread did not panic");

        first.expect("Cocoa initialization failed");
        super::ensure_cocoa_multithreaded().expect("repeated initialization failed");
    }
}
