use super::*;
use crate::tree::fixture::ensure_test_apartment;
use agent_desktop_core::{
    ElementIdentifier, IdentifierEvidence, IdentifierKind, LocatorField, NodeDescriptor,
};

fn entry(
    bounds: Option<agent_desktop_core::Rect>,
    hash: Option<u64>,
    name: Option<&str>,
    native: Option<&str>,
) -> RefEntry {
    let mut entry = crate::tree::walk::walker_fake::ref_entry("button");
    entry.identity.name = name.map(str::to_string);
    entry.identity.native_id = native.map(|value| ElementIdentifier {
        kind: IdentifierKind::AutomationId,
        value: value.to_string(),
    });
    entry.geometry = agent_desktop_core::RefGeometry {
        bounds_space: None,
        bounds,
        bounds_hash: hash,
    };
    entry.scope.path_is_absolute = true;
    entry
}

fn rect(width: f64, height: f64) -> agent_desktop_core::Rect {
    agent_desktop_core::Rect {
        x: 10.0,
        y: 10.0,
        width,
        height,
    }
}

fn evidence(bounds_hash: Option<u64>) -> LocatorEvidence {
    LocatorEvidence {
        role: LocatorField::Known("button".to_string()),
        name: LocatorField::Absent,
        value: LocatorField::Absent,
        description: LocatorField::Absent,
        identifiers: IdentifierEvidence::absent(),
        states: LocatorField::Absent,
        ref_evidence: agent_desktop_core::LocatorRefEvidence {
            window_bounds: LocatorField::Absent,
            bounds: match bounds_hash {
                Some(_) => LocatorField::Known(rect(40.0, 20.0)),
                None => LocatorField::Absent,
            },
            available_actions: LocatorField::Absent,
            descriptors: NodeDescriptor::default(),
        },
    }
}

/// Window-rootedness is a disjunction and every other builder in this file
/// leaves `root_ref` unset, which satisfies it through the first disjunct
/// alone. Both disjuncts are pinned here, in both directions: dropping the
/// absolute-path one would settle every drill-down anchor `STALE_REF` while
/// the rest of this suite stayed green.
#[test]
fn a_drill_down_ref_is_window_rooted_only_when_its_path_is_absolute() {
    let mut absolute_under_a_root = entry(None, Some(1), Some("name"), None);
    absolute_under_a_root.scope.root_ref = Some("root".to_string());
    absolute_under_a_root.scope.path_is_absolute = true;
    assert!(window_rooted(&absolute_under_a_root));

    let mut relative_under_a_root = absolute_under_a_root.clone();
    relative_under_a_root.scope.path_is_absolute = false;
    assert!(!window_rooted(&relative_under_a_root));
}

/// The other disjunct, isolated the same way: a ref with no drill-down root at
/// all is window-rooted whatever its path flag says.
#[test]
fn a_ref_with_no_drill_down_root_is_window_rooted_whatever_its_path_flag() {
    let mut rootless = entry(None, Some(1), Some("name"), None);
    rootless.scope.root_ref = None;
    rootless.scope.path_is_absolute = false;
    assert!(window_rooted(&rootless));

    rootless.scope.path_is_absolute = true;
    assert!(window_rooted(&rootless));
}

#[test]
fn a_window_rooted_non_empty_path_with_identity_qualifies_for_the_fast_path() {
    let mut absolute = entry(None, Some(1), Some("name"), Some("id"));
    absolute.scope.path.push(2);
    assert!(can_use_path_fast_path(&absolute));
}

#[test]
fn a_relative_drill_down_path_skips_the_fast_path() {
    let mut relative = entry(None, Some(1), None, Some("id"));
    relative.scope.root_ref = Some("root".to_string());
    relative.scope.path_is_absolute = false;
    assert!(!can_use_path_fast_path(&relative));
}

#[test]
fn an_empty_path_skips_the_fast_path() {
    assert!(!can_use_path_fast_path(&entry(None, Some(1), None, None)));
}

#[test]
fn a_ref_with_no_id_text_or_hash_skips_the_fast_path() {
    assert!(!can_use_path_fast_path(&entry(None, None, None, None)));
}

/// `can_use_path_fast_path` must apply the same positive-area rule
/// `provisional_geometry_candidate` promotes on, not a bare
/// `bounds_hash.is_some()`: a zero-extent stored rectangle still hashes
/// (`Rect::bounds_hash` only rejects an invalid rectangle), so an id-less,
/// text-less entry backed by one is not eligible for the geometry tier and
/// must not qualify for the fast path either.
#[test]
fn a_zero_extent_bounds_hash_does_not_qualify_for_the_fast_path() {
    let mut zero_extent = entry(Some(rect(0.0, 0.0)), Some(1), None, None);
    zero_extent.scope.path.push(0);
    assert!(!can_use_path_fast_path(&zero_extent));
}

#[test]
fn promotion_requires_a_positive_area_stored_bounds() {
    let positive = entry(Some(rect(40.0, 20.0)), Some(1), None, None);
    assert!(provisional_geometry_candidate(&positive));

    let zero_extent = entry(Some(rect(0.0, 0.0)), Some(1), None, None);
    assert!(!provisional_geometry_candidate(&zero_extent));

    let only_hash = entry(None, Some(1), None, None);
    assert!(!provisional_geometry_candidate(&only_hash));
}

#[test]
fn promotion_never_fires_when_the_entry_has_a_text_identity() {
    let named = entry(Some(rect(40.0, 20.0)), Some(1), Some("name"), None);
    assert!(!provisional_geometry_candidate(&named));

    let native = entry(Some(rect(40.0, 20.0)), Some(1), None, Some("id"));
    assert!(!provisional_geometry_candidate(&native));
}

#[test]
fn geometry_matches_only_on_the_live_bounds_hash() {
    let live_hash = rect(40.0, 20.0)
        .bounds_hash()
        .expect("a positive-area hash");
    let stored = entry(Some(rect(40.0, 20.0)), Some(live_hash), None, None);
    assert!(geometry_matches(&stored, &evidence(Some(live_hash))));
    assert!(!geometry_matches(&stored, &evidence(None)));
}

#[test]
fn geometry_matches_never_promotes_a_zero_extent_stored_hash() {
    let stored = entry(None, Some(0x1234), None, None);
    assert!(!geometry_matches(&stored, &evidence(Some(0x1234))));
}

#[test]
fn an_id_less_textless_zero_extent_ref_is_unverifiable() {
    let zero_extent = entry(Some(rect(0.0, 0.0)), Some(0x1234), None, None);
    assert!(entry_is_unverifiable(&zero_extent));

    let no_bounds_at_all = entry(None, None, None, None);
    assert!(entry_is_unverifiable(&no_bounds_at_all));
}

#[test]
fn a_ref_verifiable_by_any_single_tier_is_not_unverifiable() {
    let named = entry(None, None, Some("name"), None);
    assert!(!entry_is_unverifiable(&named));

    let identified = entry(None, None, None, Some("id"));
    assert!(!entry_is_unverifiable(&identified));

    let geometry_only = entry(Some(rect(40.0, 20.0)), Some(0x1234), None, None);
    assert!(!entry_is_unverifiable(&geometry_only));
}

/// The shape allocation emits for nameless positive-area content once it
/// keeps the rect that is the entry's only identity: locatable by the
/// geometry tier rather than failed closed by `entry_is_unverifiable`
/// before any candidate search runs - the A24-11 stale-rate mechanism.
#[test]
fn a_nameless_positive_area_ref_is_locatable_by_the_geometry_tier() {
    let geometry_only = entry(Some(rect(40.0, 20.0)), Some(0x1234), None, None);
    assert!(!has_meaningful_identity(&geometry_only));
    assert!(provisional_geometry_candidate(&geometry_only));
    assert!(!entry_is_unverifiable(&geometry_only));
    assert!(entry_is_locatable(&geometry_only));
}

#[test]
fn should_stop_collecting_fires_only_past_one_match_with_no_stored_hash() {
    let no_hash = entry(None, None, None, None);
    assert!(!should_stop_collecting(0, &no_hash));
    assert!(!should_stop_collecting(1, &no_hash));
    assert!(should_stop_collecting(2, &no_hash));

    let with_hash = entry(None, Some(0x1234), None, None);
    assert!(!should_stop_collecting(2, &with_hash));
}

/// The geometry tier's promotion decision, taken against a live control rather
/// than a hand-built one.
///
/// The fixture's password edit is the shape the tier exists for: a ref stored
/// for secure content carries no text identity, so positive-area geometry is
/// the only evidence left to verify it against. What is asserted is the
/// promotion itself - `geometry_matches` over the evidence the walk actually
/// read - and each condition that produces it is withdrawn in turn, so
/// weakening either one of them shows up here. Asserting only that the fixture
/// has a secure element would survive inverting the promotion predicate
/// outright, pinning the fixture instead of the tier.
#[test]
fn a_ref_stored_for_the_live_secure_edit_promotes_on_geometry_alone() {
    ensure_test_apartment();
    let fixture = crate::tree::fixture::HostedFixture::spawn().expect("a fixture host starts");
    let source = UiaTreeSource::for_root(
        &crate::tree::automation::root_from_hwnd(
            fixture.handle(),
            crate::tree::walk::walker_fake::deadline(),
        )
        .expect("the fixture resolves"),
    )
    .expect("a tree source");
    let prepared = source
        .prepare_root(
            &crate::tree::automation::root_from_hwnd(
                fixture.handle(),
                crate::tree::walk::walker_fake::deadline(),
            )
            .expect("the fixture resolves"),
        )
        .expect("a prepared root");
    let budget = WalkBudget::new(10, crate::tree::walk::walker_fake::deadline());
    let found = find_secure(&source, &prepared, &budget)
        .expect("the fixture walk succeeds")
        .expect("a secure element exists");
    let (_, properties, live, _) = found;
    assert!(
        properties.is_secure(),
        "the control under test is the secure edit, not some other element"
    );
    let live_bounds = *live.ref_evidence.bounds.known().expect("live bounds");
    let live_hash = live_bounds
        .bounds_hash()
        .expect("the live secure edit occupies a positive-area rectangle");

    let stored = entry(Some(live_bounds), Some(live_hash), None, None);
    assert!(
        provisional_geometry_candidate(&stored),
        "a ref with no text identity and a positive-area hash is what the tier promotes"
    );
    assert!(
        geometry_matches(&stored, &live),
        "the stored geometry must promote against the evidence the walk read"
    );

    let named = entry(Some(live_bounds), Some(live_hash), Some("Password"), None);
    assert!(
        !geometry_matches(&named, &live),
        "a ref with a text identity has a tier of its own and must never promote on geometry"
    );

    let flattened = entry(Some(rect(0.0, 0.0)), Some(live_hash), None, None);
    assert!(
        !geometry_matches(&flattened, &live),
        "a zero-extent stored rectangle is structurally non-unique and must never promote"
    );
}

fn find_secure(
    source: &UiaTreeSource,
    element: &UIAElement,
    budget: &WalkBudget,
) -> Result<
    Option<(
        agent_desktop_core::refs::RefPath,
        crate::tree::properties::ElementProperties,
        LocatorEvidence,
        u64,
    )>,
    AdapterError,
> {
    crate::tree::walk::walker_fake::scan_subtree(
        source,
        element,
        budget,
        10,
        &mut |prefix, properties, evidence, failed| {
            if properties.is_secure() {
                let mut path = agent_desktop_core::refs::RefPath::default();
                path.extend_from_slice(prefix);
                std::ops::ControlFlow::Break((path, properties, evidence, failed))
            } else {
                std::ops::ControlFlow::Continue(())
            }
        },
    )
}
