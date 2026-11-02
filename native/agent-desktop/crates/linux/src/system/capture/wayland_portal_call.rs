use std::time::{Duration, Instant};

use agent_desktop_core::{AdapterError, Deadline, DeliverySemantics, ErrorCode};

pub(crate) const PORTAL_SERVICE: &str = "org.freedesktop.portal.Desktop";

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) enum PortalAnswer {
    Granted { uri: Option<String> },
    Refused { code: u32 },
}

/// A subscription to one request's `Response` signal. It exists before the
/// call that creates the request, so a response that comes first is kept.
pub(crate) trait Pending {
    /// Closes the request so the portal drops its dialog and its result.
    fn cancel(self: Box<Self>);
    fn wait(self: Box<Self>, deadline: Deadline) -> Result<PortalAnswer, AdapterError>;
}

/// The portal's session-bus calls over plain values.
pub(crate) trait PortalWire {
    fn unique_name(&self) -> String;
    fn subscribe(
        &self,
        request_path: &str,
        deadline: Deadline,
    ) -> Result<Box<dyn Pending>, AdapterError>;
    fn call_screenshot(&self, token: &str, deadline: Deadline) -> Result<String, AdapterError>;
}

pub(crate) fn request_path(unique_name: &str, token: &str) -> String {
    let sender = unique_name.trim_start_matches(':').replace('.', "_");
    format!("/org/freedesktop/portal/desktop/request/{sender}/{token}")
}

/// How long a request must have waited before the portal's response 2 is read
/// as the portal giving up on an unanswered dialog. The portal's own limit on a
/// dialog is the 25 s of a D-Bus call (measured: response 2 at 25.03 s); an
/// earlier response 2 means the portal refused the request at once.
pub(crate) const PORTAL_PATIENCE: Duration = Duration::from_secs(20);

fn refused(code: u32, waited: Duration) -> AdapterError {
    if code == 1 {
        return AdapterError::new(
            ErrorCode::PermDenied,
            "The desktop portal did not allow the screenshot (response 1)",
        )
        .with_suggestion(
            "A person chose Deny or closed the dialog. Allow screenshots in the dialog the desktop shows; if a Deny was remembered, reset it in the desktop's privacy settings first",
        );
    }
    if waited >= PORTAL_PATIENCE {
        return timed_out(AdapterError::timeout(
            "The desktop portal stopped waiting for an answer to its screenshot dialog",
        ));
    }
    AdapterError::new(
        ErrorCode::PermDenied,
        format!("The desktop portal ended the screenshot request without a result (response {code})"),
    )
    .with_suggestion(
        "The portal shows one screenshot dialog at a time, so a dialog left open by an earlier call is the usual cause: answer it or wait up to 25 seconds for the portal to close it, then retry. Other causes: a person chose Deny, or the portal backend failed (check that xdg-desktop-portal and its backend for this desktop run)",
    )
}

fn timed_out(error: AdapterError) -> AdapterError {
    error
        .with_suggestion(
            "A person must answer or dismiss the desktop's screenshot consent dialog. It may still be open; wait until it closes before requesting another screenshot. Do not retry automatically",
        )
        .with_details(serde_json::json!({
            "kind": "portal_consent_timeout",
            "retryable": false,
            "dialog_may_be_open": true,
        }))
        .with_disposition(DeliverySemantics::uncertain())
}

fn no_uri() -> AdapterError {
    AdapterError::new(
        ErrorCode::ActionFailed,
        "The desktop portal allowed the screenshot but named no file",
    )
}

fn other_handle(handle: &str) -> AdapterError {
    AdapterError::new(
        ErrorCode::ActionFailed,
        "The desktop portal answered on a request this call did not subscribe to",
    )
    .with_platform_detail(handle)
}

/// Subscribes to the request's response, then calls `Screenshot`, then waits.
/// The order is the point: the signal can arrive before the call returns.
pub(crate) fn screenshot_uri(
    wire: &dyn PortalWire,
    token: &str,
    deadline: Deadline,
) -> Result<String, AdapterError> {
    let started = Instant::now();
    let path = request_path(&wire.unique_name(), token);
    let pending = wire.subscribe(&path, deadline)?;
    let handle = match wire.call_screenshot(token, deadline) {
        Ok(handle) => handle,
        Err(error) => {
            pending.cancel();
            return Err(if error.code == ErrorCode::Timeout {
                timed_out(error)
            } else {
                error
            });
        }
    };
    if handle != path {
        pending.cancel();
        return Err(other_handle(&handle));
    }
    match pending.wait(deadline) {
        Ok(PortalAnswer::Granted { uri: Some(uri) }) => Ok(uri),
        Ok(PortalAnswer::Granted { uri: None }) => Err(no_uri()),
        Ok(PortalAnswer::Refused { code }) => Err(refused(code, started.elapsed())),
        Err(error) if error.code == ErrorCode::Timeout => Err(timed_out(error)),
        Err(error) => Err(error),
    }
}

#[cfg(test)]
#[path = "wayland_portal_call_tests.rs"]
mod tests;
