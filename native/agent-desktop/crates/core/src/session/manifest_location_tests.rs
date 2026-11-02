use super::*;
use crate::refs::refs_test_support::HomeGuard;

/// `SESSION_MANIFEST_FILE` is public so a platform crate can read the
/// manifest as bytes without restating its name, which pins the constant to
/// wherever the writer actually puts the file. One that restated it read a
/// path that never existed, could not tell that from a deleted session, and
/// tore a live overlay down on a fixed timer.
#[test]
fn a_started_session_writes_its_manifest_where_the_public_constant_says() {
    let _guard = HomeGuard::new();
    let manifest = start_session(StartSessionOptions::default()).expect("a session starts");

    let expected = session_dir(&manifest.id)
        .expect("the session directory resolves")
        .join(SESSION_MANIFEST_FILE);

    let body = std::fs::read_to_string(&expected).unwrap_or_else(|error| {
        panic!(
            "the manifest must be readable at {}: {error}",
            expected.display()
        )
    });
    let parsed: serde_json::Value =
        serde_json::from_str(&body).expect("the manifest is the JSON a byte reader will parse");

    assert_eq!(
        parsed["id"], manifest.id,
        "the file at the published path is this session's manifest, not some other artifact"
    );
}

/// The other direction: a reader that composes the published path sees an
/// ended session as ended, so the constant carries the end signal too.
#[test]
fn ending_a_session_is_visible_to_a_reader_that_composes_the_published_path() {
    let _guard = HomeGuard::new();
    let manifest = start_session(StartSessionOptions::default()).expect("a session starts");
    let path = session_dir(&manifest.id)
        .expect("the session directory resolves")
        .join(SESSION_MANIFEST_FILE);

    let before: serde_json::Value =
        serde_json::from_str(&std::fs::read_to_string(&path).expect("manifest readable"))
            .expect("manifest parses");
    assert!(
        before
            .get("ended_at")
            .is_none_or(serde_json::Value::is_null),
        "a live session must not already look ended, or the end signal proves nothing"
    );

    end_session(&manifest.id).expect("the session ends");

    let after: serde_json::Value =
        serde_json::from_str(&std::fs::read_to_string(&path).expect("manifest readable"))
            .expect("manifest parses");
    assert!(
        !after["ended_at"].is_null() && after.get("ended_at").is_some(),
        "the end must be visible in the file a byte reader opens"
    );
}

/// A disabled cursor overlay is the config's default, and the manifest does
/// not serialize defaults — so switching the overlay off REMOVES the key
/// rather than writing `"enabled": false`.
///
/// The Windows renderer polls this file to notice that its own session no
/// longer wants it, and reads an absent key as "switched off". That is only
/// correct while this holds, and it held silently until a hand-written test
/// fixture that used the never-produced `"enabled": false` shape hid a
/// teardown condition which could not fire.
#[test]
fn the_manifest_omits_a_disabled_cursor_overlay_rather_than_writing_it_false() {
    let _guard = HomeGuard::new();
    let manifest = start_session(StartSessionOptions::default()).expect("a session starts");
    let path = session_dir(&manifest.id)
        .expect("the session directory resolves")
        .join(SESSION_MANIFEST_FILE);

    let enabled = crate::CursorOverlayConfig::enabled(None, 6).expect("an enabled config");
    set_cursor_overlay(&manifest.id, enabled).expect("the overlay switches on");
    let on: serde_json::Value =
        serde_json::from_str(&std::fs::read_to_string(&path).expect("manifest readable"))
            .expect("manifest parses");
    assert_eq!(
        on["cursor_overlay"]["enabled"], true,
        "an enabled overlay must be visible to a reader that opens this file"
    );

    set_cursor_overlay(&manifest.id, crate::CursorOverlayConfig::default())
        .expect("the overlay switches off");
    let off: serde_json::Value =
        serde_json::from_str(&std::fs::read_to_string(&path).expect("manifest readable"))
            .expect("manifest parses");
    assert!(
        off.get("cursor_overlay").is_none(),
        "a disabled overlay is omitted, not written false; a reader that expected \
         `enabled: false` would never see a session switch its overlay off"
    );
}
