use crate::tree::fixture::{HostedFixture, ensure_test_apartment};
use crate::tree::test_support::fixture_window;
use crate::tree::walk::walker_fake::deadline;
use agent_desktop_core::{
    LocatorMaterialization, LocatorResolveRequest, LocatorSelection, ObservationRoot,
    commands::query::validate_selector, resolve_query,
};

/// `find --count` and a materialized `find` must select the same set from the
/// same query.
///
/// The two run different paths - count mode resolves a total without ever
/// materializing a match - so a divergence between them is invisible to any
/// test that exercises one alone. What is pinned is the agreement relation,
/// never a literal total: the number is a property of today's fixture and
/// changes when a control is added, while the relation is the requirement and
/// holds whatever the fixture grows. The query is chosen to match more than one
/// control, because a single-match query satisfies agreement no matter how
/// either mode selected.
///
/// A real application is a poor control here, since its own count moves
/// underneath the assertion; the hosted fixture is repo-owned and
/// deterministic, so a disagreement can only come from the code under test.
#[test]
fn find_count_and_materialized_find_agree_on_the_same_query() {
    ensure_test_apartment();
    let fixture = HostedFixture::spawn().expect("a fixture host starts");
    let adapter = crate::adapter::WindowsAdapter::new();
    let window = fixture_window(&fixture);
    let query = validate_selector("textfield").expect("a role-only selector is valid");

    let counted = resolve_query(
        &adapter,
        &query,
        ObservationRoot::Window(&window),
        &LocatorResolveRequest {
            selection: LocatorSelection::Count,
            deadline: deadline(),
            max_raw_depth: 50,
            materialization: LocatorMaterialization::None,
            surface: None,
        },
    )
    .expect("count-mode resolution succeeds on the fixture");

    let materialized = resolve_query(
        &adapter,
        &query,
        ObservationRoot::Window(&window),
        &LocatorResolveRequest {
            selection: LocatorSelection::All { limit: None },
            deadline: deadline(),
            max_raw_depth: 50,
            materialization: LocatorMaterialization::SelectedMatches,
            surface: None,
        },
    )
    .expect("materialized resolution succeeds on the fixture");

    assert!(
        counted.meta.total_matches > 1,
        "the query must match more than one control, or agreement holds trivially and the two \
         selection modes have no way to disagree"
    );
    assert_eq!(
        materialized.meta.total_matches, counted.meta.total_matches,
        "materialized find must agree with count-only find on the same query"
    );
    assert_eq!(
        materialized.matches.len(),
        counted.meta.total_matches as usize,
        "the materialized match list must have one entry per counted match"
    );
    assert!(
        materialized
            .matches
            .iter()
            .all(|found| found.data.role == "textfield"),
        "every materialized match must be the counted role, not a different one that happened to tie the total"
    );
}
