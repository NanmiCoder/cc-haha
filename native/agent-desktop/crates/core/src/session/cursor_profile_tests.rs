use super::*;
use crate::{context::CommandContext, refs::refs_test_support::HomeGuard};

#[test]
fn named_profiles_inherit_session_mode_and_share_snapshots() {
    let _guard = HomeGuard::new();
    let session = start_session(Default::default()).unwrap();
    let master = CursorOverlayConfig::enabled(None, 6)
        .unwrap()
        .with_multi_agent(true);
    set_cursor_overlay(&session.id, master.clone()).unwrap();
    let profile = CursorOverlayConfig::enabled(Some("Agent A".into()), 6).unwrap();
    save_cursor_overlay_profile(&session.id, "a", profile.clone()).unwrap();
    let base = CommandContext::new(Some(session.id.clone()), None, false).unwrap();
    let a = base.clone().with_agent_id(Some("a".into())).unwrap();
    let b = base.with_agent_id(Some("b".into())).unwrap();
    assert_eq!(a.session_id(), b.session_id());
    assert_eq!(a.cursor_overlay(), &profile.with_multi_agent(true));
    assert_eq!(b.cursor_overlay(), &master);
    assert_eq!(a.for_batch_item(None).unwrap().agent_id(), Some("a"));
    let other = start_session(Default::default()).unwrap();
    set_cursor_overlay(&other.id, master.clone()).unwrap();
    let other_profile = CursorOverlayConfig::enabled(Some("Other task".into()), 6).unwrap();
    save_cursor_overlay_profile(&other.id, "a", other_profile.clone()).unwrap();
    let switched = a.for_batch_item(Some(other.id.clone())).unwrap();
    assert_eq!(switched.agent_id(), Some("a"));
    assert_eq!(switched.session_id(), Some(other.id.as_str()));
    assert_eq!(
        switched.cursor_overlay(),
        &other_profile.with_multi_agent(true)
    );
    assert_eq!(
        read_manifest(&session.id).unwrap().unwrap().cursor_overlay,
        master
    );
    set_cursor_overlay(&session.id, CursorOverlayConfig::default()).unwrap();
    assert!(
        cursor_overlay_for_session_agent(Some(&session.id), Some("a"))
            .unwrap()
            .is_disabled()
    );
    assert!(save_cursor_overlay_profile(&session.id, "a", master).is_err());
}

#[test]
fn profiles_reject_bad_identity_but_fall_back_on_corrupt_files() {
    let _guard = HomeGuard::new();
    let session = start_session(Default::default()).unwrap();
    let master = CursorOverlayConfig::enabled(None, 6).unwrap();
    set_cursor_overlay(&session.id, master.clone()).unwrap();
    for id in ["", "../a", "a/b", "a.b", &"a".repeat(65)] {
        assert!(cursor_overlay_for_session_agent(Some(&session.id), Some(id)).is_err());
    }
    let path = agent_profile_path(&session.id, "a").unwrap();
    write_private_file(&path, b"invalid json").unwrap();
    assert_eq!(
        cursor_overlay_for_session_agent(Some(&session.id), Some("a")).unwrap(),
        master
    );
    end_session(&session.id).unwrap();
    assert!(
        cursor_overlay_for_session_agent(Some(&session.id), Some("a"))
            .unwrap()
            .is_disabled()
    );
}

#[test]
fn corrupt_profile_bytes_fall_back_to_session_config() {
    let _guard = HomeGuard::new();
    let session = start_session(Default::default()).unwrap();
    let master = CursorOverlayConfig::enabled(None, 6).unwrap();
    set_cursor_overlay(&session.id, master.clone()).unwrap();
    let path = agent_profile_path(&session.id, "a").unwrap();
    write_private_file(&path, b"not json at all").unwrap();
    assert_eq!(
        cursor_overlay_for_session_agent(Some(&session.id), Some("a")).unwrap(),
        master
    );
    write_private_file(&path, br#"{"enabled":true,"max_words":0}"#).unwrap();
    assert_eq!(
        cursor_overlay_for_session_agent(Some(&session.id), Some("a")).unwrap(),
        master
    );
}

#[test]
fn missing_profile_falls_back_to_session_config() {
    let _guard = HomeGuard::new();
    let session = start_session(Default::default()).unwrap();
    let master = CursorOverlayConfig::enabled(None, 6).unwrap();
    set_cursor_overlay(&session.id, master.clone()).unwrap();
    assert_eq!(
        cursor_overlay_for_session_agent(Some(&session.id), Some("ghost")).unwrap(),
        master
    );
}

#[test]
fn valid_profile_is_used_over_session_config() {
    let _guard = HomeGuard::new();
    let session = start_session(Default::default()).unwrap();
    let master = CursorOverlayConfig::enabled(None, 6).unwrap();
    set_cursor_overlay(&session.id, master.clone()).unwrap();
    let profile = CursorOverlayConfig::enabled(Some("Agent A".into()), 6).unwrap();
    save_cursor_overlay_profile(&session.id, "a", profile.clone()).unwrap();
    assert_eq!(
        cursor_overlay_for_session_agent(Some(&session.id), Some("a")).unwrap(),
        profile.with_multi_agent(false)
    );
}

#[test]
fn agent_profiles_carry_their_own_motion() {
    let _guard = HomeGuard::new();
    let session = start_session(Default::default()).unwrap();
    let master = CursorOverlayConfig::enabled(None, 6).unwrap();
    set_cursor_overlay(&session.id, master.clone()).unwrap();
    let mut motion = crate::CursorMotionProfile::default();
    motion.set_travel_ms(200, 500);
    motion.set_dwell_ms(100);
    motion.set_seed(Some(7));
    let profile = CursorOverlayConfig::enabled(None, 6)
        .unwrap()
        .with_motion(motion.clone())
        .unwrap();
    save_cursor_overlay_profile(&session.id, "a", profile).unwrap();
    let loaded = cursor_overlay_for_session_agent(Some(&session.id), Some("a")).unwrap();
    assert_eq!(loaded.motion(), &motion);
    let other = cursor_overlay_for_session_agent(Some(&session.id), Some("b")).unwrap();
    assert!(other.motion().is_default());
}

#[test]
fn invalid_profile_motion_falls_back_to_session_config() {
    let _guard = HomeGuard::new();
    let session = start_session(Default::default()).unwrap();
    let master = CursorOverlayConfig::enabled(None, 6).unwrap();
    set_cursor_overlay(&session.id, master.clone()).unwrap();
    let path = agent_profile_path(&session.id, "a").unwrap();
    write_private_file(
        &path,
        br#"{"enabled":true,"motion":{"travel_min_ms":90,"travel_max_ms":650,"dwell_ms":200}}"#,
    )
    .unwrap();
    assert_eq!(
        cursor_overlay_for_session_agent(Some(&session.id), Some("a")).unwrap(),
        master
    );
}
