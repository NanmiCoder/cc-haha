//! How an attempt's two tiers compose into its verdict: either tier's unread
//! region alone withholds a negative one, and only a walk that read everything
//! may settle `STALE_REF`.

use crate::tree::resolve::*;

fn entry() -> RefEntry {
    let mut entry = crate::tree::walk::walker_fake::ref_entry("button");
    entry.identity.name = Some("Save".to_string());
    entry.scope.path_is_absolute = true;
    entry
}

fn landing(unread_region: bool) -> PathLanding<crate::tree::element::UIAElement> {
    PathLanding {
        element: None,
        unread_region,
    }
}

/// The path tier is the only tier that descends past the broad search's depth
/// cap, so a gap it met can be the sole evidence that the tier able to reach
/// the stored element never got to look. An attempt that let that gap die with
/// the tier would answer `STALE_REF` - "the element is gone" - off a walk that
/// never finished.
#[test]
fn a_gap_on_the_stored_path_alone_withholds_the_negative_verdict() {
    assert!(
        matches!(
            attempt_verdict(&[], &landing(true), false, &entry()),
            SearchVerdict::Incomplete
        ),
        "a candidate-less search must not settle stale while the path walk left a region unread"
    );
}

/// The search's own gap withholds it by the same rule, so neither tier is
/// privileged and neither can be dropped in favour of the other.
#[test]
fn a_gap_in_the_broad_search_alone_withholds_the_negative_verdict() {
    assert!(matches!(
        attempt_verdict(&[], &landing(false), true, &entry()),
        SearchVerdict::Incomplete
    ));
}

/// The control both pins above depend on: with every region read and no
/// candidate found, the attempt does settle. Without this, withholding on an
/// unread region would be indistinguishable from never settling at all.
#[test]
fn a_walk_that_read_everything_and_found_nothing_settles_stale() {
    assert!(matches!(
        attempt_verdict(&[], &landing(false), false, &entry()),
        SearchVerdict::Stale
    ));
}

/// The positive verdict is withheld on the same evidence: a sole match found
/// while the path walk left a region unread could be the wrong one of two, and
/// the unread part is exactly where the second would be.
#[test]
fn a_sole_match_is_retried_while_the_path_walk_left_a_region_unread() {
    assert!(matches!(
        attempt_verdict(&[None], &landing(true), false, &entry()),
        SearchVerdict::Incomplete
    ));
    assert!(
        matches!(
            attempt_verdict(&[None], &landing(false), false, &entry()),
            SearchVerdict::Resolved(0)
        ),
        "the same sole match resolves once nothing is left unread"
    );
}
