use agent_desktop_core::{DeliveryDisposition, ErrorCode};

use super::*;

fn entry() -> LayoutEntry {
    LayoutEntry {
        id: 4,
        label: "Open".into(),
        enabled: true,
        separator: false,
        submenu: false,
        checked: None,
        children: Vec::new(),
    }
}

#[test]
fn an_enabled_plain_entry_is_picked_with_a_click_event() {
    assert_eq!(validate(&entry()).ok(), Some(Pick::Clicked));
}

#[test]
fn a_disabled_entry_is_refused_before_anything_is_sent() {
    let mut disabled = entry();
    disabled.enabled = false;
    let error = validate(&disabled).expect_err("refused");
    assert_eq!(error.code, ErrorCode::ActionFailed);
    assert_eq!(
        error.disposition.delivery(),
        DeliveryDisposition::NotDelivered
    );
}

#[test]
fn a_separator_is_refused_even_when_it_is_enabled() {
    let mut separator = entry();
    separator.separator = true;
    let error = validate(&separator).expect_err("refused");
    assert_eq!(error.code, ErrorCode::ActionNotSupported);
}

#[test]
fn a_submenu_parent_opens_its_submenu_and_is_never_clicked() {
    let mut parent = entry();
    parent.submenu = true;
    assert_eq!(validate(&parent).ok(), Some(Pick::ShowSubmenu));
}

#[test]
fn a_disabled_submenu_parent_is_refused() {
    let mut parent = entry();
    parent.submenu = true;
    parent.enabled = false;
    assert!(validate(&parent).is_err());
}
