use crate::refs::RefEntry;

pub(super) fn entry() -> RefEntry {
    let bounds = crate::Rect {
        x: 1.0,
        y: 1.0,
        width: 20.0,
        height: 20.0,
    };
    let mut entry = crate::adapter::minimal_ref_entry("button", Some("OK"));
    entry.geometry = crate::RefGeometry {
        bounds_space: None,
        bounds: Some(bounds),
        bounds_hash: bounds.bounds_hash(),
    };
    entry.capabilities.available_actions = vec!["Clear".into(), "Click".into()];
    entry
}

pub(super) fn text_entry() -> RefEntry {
    let mut entry = entry();
    entry.identity.role = "textfield".into();
    entry.capabilities.available_actions = vec!["SetValue".into()];
    entry
}

pub(in crate::commands) fn save_one_ref_snapshot(role: &str, available_action: &str) -> String {
    let mut entry = entry();
    entry.identity.role = role.into();
    entry.identity.name = Some("Target".into());
    entry.capabilities.available_actions = vec![available_action.into()];
    let mut refmap = crate::refs::RefMap::new();
    refmap.allocate(entry);
    crate::refs::refs_store::RefStore::new()
        .unwrap()
        .save_new_snapshot(&refmap)
        .unwrap()
}
