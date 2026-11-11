use super::*;
use crate::adapter::{ActionOps, InputOps, ObservationOps, SystemOps};
use crate::{
    AdapterError, Rect, adapter::NativeHandle, refs::RefEntry, refs::RefMap,
    refs::refs_store::RefStore, refs::refs_test_support::HomeGuard,
};
use std::sync::Mutex;

struct LiveBoundsAdapter {
    bounds: Mutex<Option<Rect>>,
    bounds_supported: bool,
}

impl LiveBoundsAdapter {
    fn with_live(bounds: Rect) -> Self {
        Self {
            bounds: Mutex::new(Some(bounds)),
            bounds_supported: true,
        }
    }

    fn without_live_support() -> Self {
        Self {
            bounds: Mutex::new(None),
            bounds_supported: false,
        }
    }

    fn resolvable_but_boundless() -> Self {
        Self {
            bounds: Mutex::new(None),
            bounds_supported: true,
        }
    }
}

impl ObservationOps for LiveBoundsAdapter {
    fn resolve_element_strict(
        &self,
        _entry: &RefEntry,
        _deadline: crate::Deadline,
    ) -> Result<NativeHandle, AdapterError> {
        Ok(NativeHandle::null())
    }

    fn get_element_bounds(
        &self,
        _handle: &NativeHandle,
        _deadline: crate::Deadline,
    ) -> Result<Option<Rect>, AdapterError> {
        if !self.bounds_supported {
            return Err(AdapterError::not_supported("get_element_bounds"));
        }
        Ok(*self.bounds.lock().unwrap())
    }
}

impl ActionOps for LiveBoundsAdapter {}

impl InputOps for LiveBoundsAdapter {}

impl SystemOps for LiveBoundsAdapter {}

fn save_entry(entry: RefEntry) -> String {
    let mut refmap = RefMap::new();
    refmap.allocate(entry);
    RefStore::new().unwrap().save_new_snapshot(&refmap).unwrap()
}

fn stale_snapshot_bounds() -> Rect {
    Rect {
        x: 84.0,
        y: -322.0,
        width: 200.0,
        height: 20.0,
    }
}

fn live_bounds() -> Rect {
    Rect {
        x: 84.0,
        y: 289.0,
        width: 200.0,
        height: 20.0,
    }
}

fn entry_with_bounds(bounds: Option<Rect>) -> RefEntry {
    let mut entry = crate::adapter::minimal_ref_entry("textfield", Some("text-input"));
    entry.geometry = crate::RefGeometry {
        bounds_space: None,
        bounds,
        bounds_hash: bounds.and_then(|b| b.bounds_hash()),
    };
    entry
}

/// A ref's stored geometry is a snapshot-time fact: an ancestor scroll
/// between snapshot and `get` moves the element without ever touching that
/// ref's refmap entry. `get --property bounds` exists to answer "where is
/// this element right now", so it must prefer a live read the same way
/// `text`/`value` already do (get.rs) — never silently serve the
/// snapshot-time position as if it were current.
#[test]
fn bounds_prefers_a_live_read_over_the_stale_snapshot_geometry() {
    let _guard = HomeGuard::new();
    let snapshot_id = save_entry(entry_with_bounds(Some(stale_snapshot_bounds())));
    let adapter = LiveBoundsAdapter::with_live(live_bounds());

    let result = execute(
        GetArgs {
            ref_id: format!("@{}:e1", snapshot_id),
            property: GetProperty::Bounds,
        },
        &adapter,
        &CommandContext::default(),
    )
    .unwrap();

    assert_eq!(result["value"]["y"], 289.0);
    assert_ne!(result["value"]["y"], -322.0);
    assert_eq!(result["live"], true);
}

/// When the platform cannot answer a live bounds read, the stored geometry
/// is the only evidence available and remains the fallback.
#[test]
fn bounds_falls_back_to_snapshot_geometry_when_no_live_read_is_available() {
    let _guard = HomeGuard::new();
    let snapshot_id = save_entry(entry_with_bounds(Some(stale_snapshot_bounds())));
    let adapter = LiveBoundsAdapter::without_live_support();

    let result = execute(
        GetArgs {
            ref_id: format!("@{}:e1", snapshot_id),
            property: GetProperty::Bounds,
        },
        &adapter,
        &CommandContext::default(),
    )
    .unwrap();

    assert_eq!(result["value"], json!(stale_snapshot_bounds()));
    assert_eq!(result["live"], false);
}

/// A live read can succeed and still report no bounds (collapsed, not laid
/// out, virtualized). The answer is `null`, not the snapshot-time rectangle:
/// a caller piping bounds into `mouse-click --x --y` must never receive
/// coordinates the element may no longer occupy. `live` stays `true`, because
/// the null did come from a live read.
#[test]
fn bounds_reports_null_not_the_snapshot_rect_when_a_live_read_finds_no_bounds() {
    let _guard = HomeGuard::new();
    let snapshot_id = save_entry(entry_with_bounds(Some(stale_snapshot_bounds())));
    let adapter = LiveBoundsAdapter::resolvable_but_boundless();

    let result = execute(
        GetArgs {
            ref_id: format!("@{}:e1", snapshot_id),
            property: GetProperty::Bounds,
        },
        &adapter,
        &CommandContext::default(),
    )
    .unwrap();

    assert!(result["value"].is_null());
    assert_eq!(result["live"], true);
}

/// `text` answers the text a person reads on the control, which is the value
/// where the value is the content and the accessible name everywhere else.
/// Both directions are pinned here because the shipped reference describes
/// both, and a change to either must move that wording with it.
#[test]
fn text_reads_the_name_on_a_labelled_button_and_the_value_on_a_textfield() {
    let _guard = HomeGuard::new();
    let mut labelled_button = entry_with_bounds(Some(stale_snapshot_bounds()));
    labelled_button.identity.role = "button".into();
    labelled_button.identity.name = Some("Close".into());
    labelled_button.identity.value = None;
    let button_snapshot = save_entry(labelled_button);

    let mut filled_field = entry_with_bounds(Some(stale_snapshot_bounds()));
    filled_field.identity.role = "textfield".into();
    filled_field.identity.name = Some("Search".into());
    filled_field.identity.value = Some("kittens".into());
    let field_snapshot = save_entry(filled_field);

    let adapter = LiveBoundsAdapter::without_live_support();
    let read = |snapshot: &str, property| {
        execute(
            GetArgs {
                ref_id: format!("@{}:e1", snapshot.to_owned()),
                property,
            },
            &adapter,
            &CommandContext::default(),
        )
        .expect("get succeeds")
    };

    assert_eq!(
        read(&button_snapshot, GetProperty::Text)["value"],
        "Close",
        "a button carries no value, so the text a person reads is its label"
    );
    assert!(
        read(&button_snapshot, GetProperty::Value)["value"].is_null(),
        "value stays the raw value read, so a caller who wants it specifically still has it"
    );
    assert_eq!(read(&button_snapshot, GetProperty::Title)["value"], "Close");

    assert_eq!(
        read(&field_snapshot, GetProperty::Text)["value"],
        "kittens",
        "a textfield carries its content in its value, so that is what is read"
    );
    assert_eq!(read(&field_snapshot, GetProperty::Title)["value"], "Search");
}

/// The cross-fallback, in both directions, so neither preference is a rule
/// that silently answers empty when its preferred half is missing.
#[test]
fn each_preference_falls_back_across_when_its_own_half_is_empty() {
    let _guard = HomeGuard::new();
    let mut empty_field = entry_with_bounds(Some(stale_snapshot_bounds()));
    empty_field.identity.role = "textfield".into();
    empty_field.identity.name = Some("Search".into());
    empty_field.identity.value = Some("   ".into());
    let field_snapshot = save_entry(empty_field);

    let mut nameless_cell = entry_with_bounds(Some(stale_snapshot_bounds()));
    nameless_cell.identity.role = "cell".into();
    nameless_cell.identity.name = None;
    nameless_cell.identity.value = Some("42".into());
    let cell_snapshot = save_entry(nameless_cell);

    let adapter = LiveBoundsAdapter::without_live_support();
    let read = |snapshot: &str| {
        execute(
            GetArgs {
                ref_id: format!("@{}:e1", snapshot.to_owned()),
                property: GetProperty::Text,
            },
            &adapter,
            &CommandContext::default(),
        )
        .expect("get succeeds")
    };

    assert_eq!(
        read(&field_snapshot)["value"],
        "Search",
        "a blank value is not text a person reads, so the label answers instead"
    );
    assert_eq!(
        read(&cell_snapshot)["value"],
        "42",
        "a nameless cell answers the content its value carries"
    );
}
