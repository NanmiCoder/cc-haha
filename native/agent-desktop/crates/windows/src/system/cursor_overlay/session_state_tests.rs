use super::{EndWatch, SessionReading, classify};

fn unreadable() -> Option<std::io::Result<String>> {
    Some(Err(std::io::Error::new(
        std::io::ErrorKind::PermissionDenied,
        "the manifest was being replaced",
    )))
}

fn missing() -> Option<std::io::Result<String>> {
    Some(Err(std::io::Error::new(
        std::io::ErrorKind::NotFound,
        "no manifest",
    )))
}

#[test]
fn a_live_session_reads_live() {
    let body = r#"{"id":"s0000001","cursor_overlay":{"enabled":true}}"#;

    assert_eq!(classify(Some(Ok(body.to_owned()))), SessionReading::Live);
}

#[test]
fn an_ended_session_reads_finished() {
    let body = r#"{"id":"s0000001","ended_at":"2026-09-01T00:00:00Z"}"#;

    assert_eq!(
        classify(Some(Ok(body.to_owned()))),
        SessionReading::Finished
    );
}

#[test]
fn a_missing_manifest_reads_finished() {
    assert_eq!(classify(missing()), SessionReading::Finished);
    assert_eq!(classify(None), SessionReading::Finished);
}

/// A `Present` that raced an acknowledged `Disable` can bring a fresh
/// renderer up against a session whose overlay is switched off. Without this
/// condition it would rest on screen until the session ended.
#[test]
fn a_session_whose_overlay_is_switched_off_reads_finished() {
    let body = r#"{"id":"s0000001","cursor_overlay":{"enabled":false}}"#;

    assert_eq!(
        classify(Some(Ok(body.to_owned()))),
        SessionReading::Finished
    );
}

/// The shape `cursor-overlay disable` actually leaves behind, taken from a
/// real manifest rather than written by hand.
///
/// A disabled overlay is the config's default and defaults are not
/// serialized, so switching it off **removes** the key — the manifest never
/// contains `"enabled": false` at all. The hand-written fixture above is a
/// shape the product does not produce, which is why it passed for a condition
/// that could not fire. `the_manifest_omits_a_disabled_cursor_overlay_rather_than_writing_it_false` in core
/// pins the serialization this relies on.
#[test]
fn a_manifest_with_the_overlay_key_removed_reads_finished() {
    let body = r#"{"id":"s0000001","created_at":1788312770975,"trace":"on","artifacts":"events"}"#;

    assert_eq!(
        classify(Some(Ok(body.to_owned()))),
        SessionReading::Finished
    );
}

/// An overlay object whose `enabled` is present but not a boolean is a
/// malformed read, not a switched-off session, so it must not tear anything
/// down.
#[test]
fn an_overlay_with_an_unreadable_enabled_flag_reads_unknown() {
    let body = r#"{"id":"s0000001","cursor_overlay":{"enabled":"yes"}}"#;

    assert_eq!(classify(Some(Ok(body.to_owned()))), SessionReading::Unknown);
}

/// The distinction this module exists for. Core's reader folds both of these
/// into the same value a deleted session produces, so polling it would end a
/// live overlay on a transient file error - a fault read as a fact, which is
/// the defect this separation exists to prevent, reintroduced by the very
/// mechanism added to close a different hole.
#[test]
fn an_unreadable_or_unparsable_manifest_reads_unknown_not_finished() {
    assert_eq!(classify(unreadable()), SessionReading::Unknown);
    assert_eq!(
        classify(Some(Ok("this is not json".to_owned()))),
        SessionReading::Unknown
    );
}

/// The rule the module documents is two *consecutive* finished readings.
/// Without a reset on `Unknown` it was "two finished readings, ever", so a
/// manifest rewritten between the two - which is exactly what
/// `set_cursor_overlay` and ending a session produce - tore a live overlay
/// down through the very tick the rule exists to absorb.
#[test]
fn an_unreadable_tick_between_two_finished_ones_resets_the_count() {
    let mut watch = EndWatch::default();

    assert!(!watch.observe(SessionReading::Finished));
    assert!(!watch.observe(SessionReading::Unknown));
    assert!(
        !watch.observe(SessionReading::Finished),
        "the two finished readings were not consecutive"
    );
    assert!(watch.observe(SessionReading::Finished));
}

#[test]
fn one_unreadable_tick_never_ends_a_live_overlay() {
    let mut watch = EndWatch::default();

    assert!(!watch.observe(SessionReading::Live));
    assert!(!watch.observe(SessionReading::Unknown));
    assert!(!watch.observe(SessionReading::Unknown));
    assert!(!watch.observe(SessionReading::Live));
}

/// Two consecutive readings, so the manifest being rewritten mid-session
/// cannot be mistaken for the session ending.
#[test]
fn teardown_needs_two_consecutive_finished_readings() {
    let mut watch = EndWatch::default();

    assert!(!watch.observe(SessionReading::Finished));
    assert!(watch.observe(SessionReading::Finished));
}

#[test]
fn a_live_reading_between_two_finished_ones_resets_the_count() {
    let mut watch = EndWatch::default();

    assert!(!watch.observe(SessionReading::Finished));
    assert!(!watch.observe(SessionReading::Live));
    assert!(!watch.observe(SessionReading::Finished));
    assert!(watch.observe(SessionReading::Finished));
}

/// A session id whose path cannot be resolved used to answer `None`, which
/// `classify` reads as a finished session - a fault counted toward teardown,
/// in the module written to keep those two apart.
#[cfg(target_os = "windows")]
#[test]
fn a_session_id_whose_path_cannot_be_resolved_reads_unknown() {
    assert_eq!(
        classify(super::read_manifest("../not-a-session-id")),
        SessionReading::Unknown
    );
}

/// The manifest poll reads through this crate's hardened private-file read,
/// so the happy path is proved rather than assumed: the live teardown suite
/// only works while an ordinary manifest is still readable through it.
#[cfg(target_os = "windows")]
mod hardened_read {
    use super::{SessionReading, classify};
    use crate::system::private_file::tests::Scratch;
    use crate::system::private_file::{WindowsPrivateFile, read_private_bounded_path};
    use agent_desktop_core::PrivateFileOps;
    use std::path::Path;

    const MANIFEST_READ_LIMIT: u64 = 64 * 1024;

    /// A manifest that is gone must still read as gone THROUGH the hardened
    /// path, or the renderer that outlived its session never learns the
    /// session ended.
    ///
    /// The old read was `std::fs::read_to_string`, whose `NotFound` is
    /// self-evident. Two layers now sit in front of it, and only `NotFound`
    /// counts as an ended session - every other error is "keep drawing". So a
    /// hardened read that wrapped a missing file in an error of its own would
    /// not fail loudly; it would leave a topmost click-through window on
    /// screen with nothing in the product able to remove it, which is the one
    /// state this whole watch exists to prevent.
    #[test]
    fn a_manifest_that_is_gone_still_reads_as_gone_through_the_hardened_path() {
        let scratch = Scratch::new("absent");
        let path = scratch.path().join("session.json");

        let error = read_private_bounded_path(&path, MANIFEST_READ_LIMIT)
            .expect_err("a file that was never written cannot be read");

        assert_eq!(
            error.kind(),
            std::io::ErrorKind::NotFound,
            "only NotFound is read as an ended session, so a missing manifest must arrive as it"
        );
        assert_eq!(classify(Some(Err(error))), SessionReading::Finished);
    }

    /// The other half: a session directory removed wholesale, which is what
    /// `session gc` and an operator deleting the state root actually do. On
    /// Windows that is a different Win32 code from a missing leaf, and it has
    /// to reach the same reading.
    #[test]
    fn a_session_directory_that_is_gone_reads_as_gone_too() {
        let scratch = Scratch::new("absent-dir");
        let path = scratch.path().join("removed").join("session.json");

        let error = read_private_bounded_path(&path, MANIFEST_READ_LIMIT)
            .expect_err("a file under a directory that does not exist cannot be read");

        assert_eq!(error.kind(), std::io::ErrorKind::NotFound);
        assert_eq!(classify(Some(Err(error))), SessionReading::Finished);
    }

    fn read_back(path: &Path) -> String {
        let bytes = read_private_bounded_path(path, MANIFEST_READ_LIMIT)
            .expect("an ordinary file this process owns reads through the hardened path");
        String::from_utf8(bytes).expect("the manifest is utf-8")
    }

    #[test]
    fn an_ordinary_file_written_beside_it_reads_straight_back() {
        let scratch = Scratch::new("plain");
        let path = scratch.path().join("session.json");
        std::fs::write(&path, "{\"id\":\"s0000001\"}").expect("the scratch file writes");

        assert_eq!(read_back(&path), "{\"id\":\"s0000001\"}");
    }

    /// The manifest the product itself writes - serialized the way
    /// `write_manifest` serializes it and promoted through the same atomic
    /// write path - must classify as a live session when read back through
    /// the hardened read, or every live teardown test would be asserting
    /// against a session the renderer can no longer see.
    #[test]
    fn a_manifest_written_by_the_product_reads_back_as_a_live_session() {
        let scratch = Scratch::new("manifest");
        let path = scratch.path().join("session.json");
        let manifest = agent_desktop_core::session::SessionManifest {
            id: "s0000001".to_owned(),
            name: None,
            created_at: 1_788_312_770_975,
            ended_at: None,
            trace: agent_desktop_core::session::SessionTraceMode::On,
            artifacts: agent_desktop_core::session::ArtifactsMode::Events,
            cursor_overlay: agent_desktop_core::CursorOverlayConfig::enabled(None, 8)
                .expect("an enabled overlay config"),
        };
        let json = serde_json::to_string_pretty(&manifest).expect("the manifest serializes");
        WindowsPrivateFile::new()
            .write_atomic(&path, json.as_bytes())
            .expect("the product's atomic write lands in the scratch root");

        assert_eq!(classify(Some(Ok(read_back(&path)))), SessionReading::Live);
    }

    /// The cap is the other half of the hardening, and a manifest over it is
    /// refused rather than read into the renderer.
    #[test]
    fn a_file_past_the_read_limit_is_refused_rather_than_read() {
        let scratch = Scratch::new("oversized");
        let path = scratch.path().join("session.json");
        std::fs::write(&path, vec![b'x'; (MANIFEST_READ_LIMIT + 1) as usize])
            .expect("the oversized scratch file writes");

        let error = read_private_bounded_path(&path, MANIFEST_READ_LIMIT)
            .map(|bytes| bytes.len())
            .expect_err("a file past the cap is refused");

        assert_eq!(error.kind(), std::io::ErrorKind::InvalidData);
    }
}
