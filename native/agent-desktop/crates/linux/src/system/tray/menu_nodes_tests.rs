use super::*;

#[test]
fn states_follow_enabled_checked_and_submenu() {
    let mut entry = LayoutEntry {
        id: 4,
        label: "Check".into(),
        enabled: true,
        separator: false,
        submenu: false,
        checked: None,
        children: Vec::new(),
    };
    assert!(states_of(&entry).is_empty());
    entry.enabled = false;
    entry.checked = Some(true);
    entry.submenu = true;
    assert_eq!(states_of(&entry), ["disabled", "checked", "haspopup"]);
}
