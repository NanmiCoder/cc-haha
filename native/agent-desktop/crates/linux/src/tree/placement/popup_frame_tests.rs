use super::*;

#[test]
fn only_gtk4_menu_frames_use_the_popup_origin() {
    for (name, version, role, expected) in [
        ("GTK", "4.14.5", Some(MENU), true),
        ("GTK", "3.24", Some(MENU), false),
        ("Qt", "6", Some(MENU), false),
        ("GTK", "4.14.5", Some(23), false),
        ("GTK", "4.14.5", None, false),
    ] {
        let toolkit = ToolkitId {
            name: Some(name.to_owned()),
            version: Some(version.to_owned()),
        };
        assert_eq!(uses_popup_origin(role, &toolkit, false), expected);
    }
}

#[test]
fn gtk4_panels_require_a_proven_menu_context_before_using_a_popup_origin() {
    let toolkit = ToolkitId {
        name: Some("GTK".to_owned()),
        version: Some("4.14.5".to_owned()),
    };
    assert!(!uses_popup_origin(Some(PANEL), &toolkit, false));
    assert!(uses_popup_origin(Some(PANEL), &toolkit, true));
    assert!(!uses_popup_origin(Some(23), &toolkit, true));
    let gtk3 = ToolkitId {
        version: Some("3.24".to_owned()),
        ..toolkit
    };
    assert!(!uses_popup_origin(Some(PANEL), &gtk3, true));
}
