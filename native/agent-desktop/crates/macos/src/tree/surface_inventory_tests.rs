use super::*;
use std::time::Duration;

#[test]
fn expired_deadline_fails_before_accessibility_inventory() {
    let deadline = Instant::now() - Duration::from_millis(1);

    let pid = i32::try_from(std::process::id()).expect("test pid fits macOS pid_t");
    let error = list_surfaces_for_pid(pid, deadline)
        .expect_err("an expired surface inventory must time out");

    assert_eq!(error.code.as_str(), "TIMEOUT");
}

fn surface(kind: &str) -> SurfaceInfo {
    SurfaceInfo {
        id: kind.into(),
        kind: kind.into(),
        title: None,
        item_count: None,
        unclassified: Vec::new(),
    }
}

#[test]
fn shared_menu_discovery_preserves_other_surfaces_and_existing_menu_ids() {
    let mut surfaces = vec![surface("sheet")];
    complete_menu_inventory(&mut surfaces, |surfaces| {
        surfaces.push(surface("context_menu"));
        Ok(())
    })
    .unwrap();
    assert_eq!(surfaces.len(), 2);
    assert_eq!(surfaces[0].kind, "sheet");
    assert_eq!(surfaces[1].kind, "context_menu");

    for kind in ["menu", "context_menu"] {
        let mut surfaces = vec![surface(kind)];
        complete_menu_inventory(&mut surfaces, |_| panic!("must not duplicate menus")).unwrap();
        assert_eq!(surfaces.len(), 1);
        assert_eq!(surfaces[0].id, kind);
    }
}

#[test]
fn incomplete_shared_discovery_is_not_reported_as_an_empty_inventory() {
    let mut surfaces = Vec::new();
    let error = complete_menu_inventory(&mut surfaces, |_| Err(AdapterError::permission_denied()))
        .unwrap_err();
    assert_eq!(error.code.as_str(), "PERM_DENIED");
    assert!(surfaces.is_empty());
}
