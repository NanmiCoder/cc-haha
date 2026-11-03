use super::*;

#[test]
fn scroll_positions_neither_prove_nor_reject_element_identity() {
    for role in ["scrollbar", "handle"] {
        for promoted_name in [false, true] {
            let mut saved = entry();
            saved.identity.role = role.into();
            saved.identity.value = Some("0".into());
            saved.identity.name = promoted_name.then(|| "0".into());
            assert!(!has_meaningful_identity(&saved), "{role}");
            for live_value in ["0", "0.10000000149011612"] {
                let name = if promoted_name {
                    LocatorField::Known(live_value.into())
                } else {
                    LocatorField::Absent
                };
                assert_eq!(
                    identity_match(
                        &saved,
                        &name,
                        &LocatorField::Known(live_value.into()),
                        &LocatorField::Absent,
                        &IdentifierEvidence::typed([], None, true),
                    ),
                    IdentityMatch::Unknown,
                    "{role} must require geometry or native identity, not scroll position",
                );
            }
        }
    }
}

#[test]
fn named_scroll_controls_still_require_the_same_label() {
    for role in ["scrollbar", "handle"] {
        let mut saved = entry();
        saved.identity.role = role.into();
        saved.identity.name = Some("Document scroll position".into());
        saved.identity.value = Some("0".into());
        assert!(has_meaningful_identity(&saved));
        assert!(identity_matches(
            &saved,
            Some("Document scroll position"),
            Some("0.1"),
            None,
            None,
        ));
        assert!(!identity_matches(
            &saved,
            Some("Sidebar scroll position"),
            Some("0.1"),
            None,
            None,
        ));
    }
}
