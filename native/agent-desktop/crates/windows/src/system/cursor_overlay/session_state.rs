//! Whether the session this renderer serves is still live.
//!
//! A session can end without a `disable` ever reaching the renderer — a
//! crashed agent, a `session gc`, an operator who simply stops — and the
//! child has no console, no taskbar entry and no Alt-Tab presence, so an
//! abandoned overlay would be a topmost animated window with nothing in the
//! product able to remove it. It therefore ends itself.
//!
//! It does **not** use core's manifest reader, and the reason is the defect
//! class this crate keeps correcting: that reader routes every non-`NotFound`
//! error and every parse failure into the same `Ok(None)` a deleted session
//! produces, so polling it would tear a live overlay down on a transient file
//! error. Fault and absence are separated here, and only absence counts.
//!
//! Two consecutive readings are required before teardown, so a single
//! unreadable tick — the manifest is rewritten mid-session by
//! `set_cursor_overlay` and by ending a session — never ends a healthy
//! overlay.

/// What one look at the manifest established.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum SessionReading {
    /// The session is live and still wants an overlay.
    Live,
    /// The manifest is gone, its end is recorded, or its overlay is switched
    /// off. Any of the three means this renderer should stop.
    Finished,
    /// The manifest could not be read or could not be parsed. Not a fact
    /// about the session, so it is never a reason to tear down.
    Unknown,
}

pub(crate) fn classify(raw: Option<std::io::Result<String>>) -> SessionReading {
    match raw {
        None => SessionReading::Finished,
        Some(Err(error)) if error.kind() == std::io::ErrorKind::NotFound => {
            SessionReading::Finished
        }
        Some(Err(_)) => SessionReading::Unknown,
        Some(Ok(body)) => classify_body(&body),
    }
}

/// A disabled overlay is the config default, and the manifest does not
/// serialize defaults - so switching the overlay off REMOVES the
/// `cursor_overlay` key rather than setting it to false. Reading an absent
/// key as "still enabled" is what made that whole teardown condition unable
/// to fire.
fn classify_body(body: &str) -> SessionReading {
    let Ok(value) = serde_json::from_str::<serde_json::Value>(body) else {
        return SessionReading::Unknown;
    };
    if value.get("ended_at").is_some_and(|ended| !ended.is_null()) {
        return SessionReading::Finished;
    }
    match value.get("cursor_overlay") {
        None => SessionReading::Finished,
        Some(overlay) => match overlay.get("enabled").and_then(serde_json::Value::as_bool) {
            Some(true) => SessionReading::Live,
            Some(false) => SessionReading::Finished,
            None => SessionReading::Unknown,
        },
    }
}

/// Tracks consecutive readings so one unreadable tick cannot end a live
/// overlay.
///
/// `Unknown` resets the count rather than passing over it. Without the reset
/// the rule was "two finished readings, ever", so a finished reading, an
/// unreadable tick and a second finished reading tore the overlay down - and
/// an unreadable tick is exactly what a manifest being rewritten mid-session
/// produces, which is the case the rule exists to survive.
#[derive(Default)]
pub(crate) struct EndWatch {
    consecutive_finished: u8,
}

impl EndWatch {
    /// True once the session has read finished twice running.
    pub(crate) fn observe(&mut self, reading: SessionReading) -> bool {
        match reading {
            SessionReading::Finished => {
                self.consecutive_finished = self.consecutive_finished.saturating_add(1);
                self.consecutive_finished >= 2
            }
            SessionReading::Live => {
                self.consecutive_finished = 0;
                false
            }
            SessionReading::Unknown => {
                self.consecutive_finished = 0;
                false
            }
        }
    }
}

/// The manifest's bytes, or the error that stopped them being read.
///
/// It does not use core's typed reader, which routes every non-`NotFound`
/// error and every parse failure into the same `Ok(None)` a deleted session
/// produces. The path comes from core so this cannot drift from where the
/// manifest actually lives, and a path that cannot be resolved is reported as
/// an error rather than as a missing manifest: a state root that is
/// momentarily unreadable is not a session that ended.
///
/// The bytes come through this crate's hardened private-file read - no-follow
/// leaf open, owner check, size cap - so a symlink planted in the state root
/// cannot redirect the poll and an oversized `session.json` cannot balloon
/// the renderer. The trade-off is real and worth stating: a hardened read
/// that fails classifies as `Unknown`, so on a misconfigured state root - one
/// owned by another principal, or with a reparse point on the manifest - this
/// renderer never self-reclaims and keeps drawing. That is the safe direction
/// (it will not tear down a live session over a file it could not read) but
/// it is a genuine stuck-overlay mode, ended only by `cursor-overlay disable`
/// or by killing the renderer.
#[cfg(target_os = "windows")]
pub(crate) fn read_manifest(session_id: &str) -> Option<std::io::Result<String>> {
    const MANIFEST_READ_LIMIT: u64 = 64 * 1024;

    let directory = match agent_desktop_core::session::session_dir(session_id) {
        Ok(directory) => directory,
        Err(error) => return Some(Err(std::io::Error::other(error.to_string()))),
    };
    let path = directory.join(agent_desktop_core::session::SESSION_MANIFEST_FILE);
    Some(
        crate::system::private_file::read_private_bounded_path(&path, MANIFEST_READ_LIMIT)
            .and_then(decode_manifest),
    )
}

#[cfg(target_os = "windows")]
fn decode_manifest(bytes: Vec<u8>) -> std::io::Result<String> {
    String::from_utf8(bytes)
        .map_err(|error| std::io::Error::new(std::io::ErrorKind::InvalidData, error))
}

/// There is no renderer off Windows, so this answers "nothing was read"
/// rather than "the session ended" - the same side of the rule the live
/// reader takes, so a stub can never be the thing that tears an overlay down.
#[cfg(not(target_os = "windows"))]
pub(crate) fn read_manifest(_session_id: &str) -> Option<std::io::Result<String>> {
    Some(Err(std::io::Error::other(
        "the session manifest is only read on the platform that renders the overlay",
    )))
}

#[cfg(test)]
#[path = "session_state_tests.rs"]
mod tests;
