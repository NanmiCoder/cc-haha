use agent_desktop_core::{AdapterError, ErrorCode};

/// Records that the overlay lifecycle update did nothing. A platform with no
/// overlay is an expected outcome that the response already reports as
/// `rendered: false`, so only an unexpected failure reaches standard error.
pub(super) fn log(error: &AdapterError) {
    if error.code == ErrorCode::PlatformNotSupported {
        tracing::debug!(code = %error.code.as_str(), "cursor overlay lifecycle update was skipped");
    } else {
        tracing::warn!(code = %error.code.as_str(), "cursor overlay lifecycle update was skipped");
    }
}

#[cfg(test)]
#[path = "overlay_skipped_tests.rs"]
mod tests;
