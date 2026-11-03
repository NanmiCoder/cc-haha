//! The resolution search family: the bounded broad search, the path
//! fast-path, and the geometry promotion.
//!
//! Split from `resolve.rs` so that neither file crosses the 400-line cap.
//! Everything here mirrors a shape the macOS adapter already settled: the
//! search's role gate and its incomplete tracking, the path fast-path behind
//! `can_use_path_fast_path` (`crates/macos/src/tree/resolve/mod.rs`), and the
//! geometry promotion predicate `provisional_geometry_candidate`
//! (`crates/macos/src/tree/resolve/resolve_search.rs`) - with one Windows-measured
//! addition, that the stored hash must come from a positive-area rectangle
//! (A17-7).

use agent_desktop_core::{
    AdapterError, Deadline, LocatorEvidence, RefEntry, refs::ref_identity::has_meaningful_identity,
};

use super::resolve_match::{Candidate, CandidateOutcome, bounds_hash_of};
use crate::system::runtime::hresult::ReadDisposition;
use crate::tree::automation::{UiaFailure, uia_failure_disposition};
use crate::tree::element::UIAElement;
use crate::tree::walk::walker::{DEFAULT_MAX_SIBLINGS, TreeSource, WalkBudget};
use crate::tree::walk::walker_source::UiaTreeSource;
use descent::{DescentPolicy, DescentVerdict, ExpiryPolicy};

#[path = "resolve_descent.rs"]
pub(crate) mod descent;

/// The resolve-scoped depth cap.
///
/// Independently bounded from the walk's own ceiling, mirroring macOS's
/// `MAX_RESOLVE_DEPTH` (`crates/macos/src/tree/resolve/mod.rs:17`). Electron
/// elements commonly sit at depth 25+, so the cap is the search bound rather
/// than the walk bound.
pub(crate) const MAX_RESOLVE_DEPTH: u8 = 50;

/// The budget a resolution attempt enumerates under.
///
/// The sibling bound is the observation walk's own `DEFAULT_MAX_SIBLINGS`
/// rather than a resolve-scoped number, and that is load-bearing rather than
/// incidental. `read_children` reports a cap-hit as a whole child list, so a
/// truncation here settles `STALE_REF` instead of retrying; that verdict is
/// only honest while the resolver reaches at least as far as the walk that
/// issued the ref, which presents no cap-cut list as whole and therefore
/// allocates no ref past its own bound. A lower bound here would convert
/// reachable refs into settled misses with nothing else refuting them.
pub(crate) fn resolve_walk_budget(deadline: Deadline) -> WalkBudget {
    WalkBudget::new(MAX_RESOLVE_DEPTH, deadline)
        .with_max_raw_depth(MAX_RESOLVE_DEPTH)
        .with_max_siblings(DEFAULT_MAX_SIBLINGS)
}

/// The incomplete-and-retryable answer: a candidate that could not be read is
/// not a non-match. Core owns the payload
/// (`agent_desktop_core::refs::resolve_errors::identity_unknown_error`) because it
/// is byte-identical to macOS's `identity_unknown` - a `complete: false,
/// retryable: true` stamp so the caller's loop retries it.
pub(crate) use agent_desktop_core::refs::resolve_errors::identity_unknown_error;

/// Whether the stored path is scoped to the window root rather than to a
/// drill-down ancestor: no `root_ref` at all, or an absolute path that
/// overrides one. Shared by every eligibility gate below - the fast path,
/// the anchor - so window-rootedness is decided in exactly one place.
pub(crate) fn window_rooted(entry: &RefEntry) -> bool {
    entry.scope.root_ref.is_none() || entry.scope.path_is_absolute
}

/// Whether the stored ref is locatable by any resolution tier at all:
/// window-rooted, and not [`entry_is_unverifiable`] - an id, stable text, or
/// a positive-area bounds hash eligible for the geometry tier
/// ([`provisional_geometry_candidate`] is the exact predicate that tier
/// promotes on, reused rather than re-derived).
///
/// This is the anchor's entire eligibility gate, and the fast path's
/// eligibility gate before its own non-empty-path conjunct. A bare
/// `RefEntry::geometry.bounds_hash` is not this signal: a zero-extent
/// rectangle still hashes (`Rect::bounds_hash` only rejects an invalid
/// rectangle, not an empty one), so a hash-only check would pass an id-less,
/// text-less entry the geometry tier can never actually promote, land the
/// path, and only then discover it cannot verify - burning the retry budget
/// on a landing that was never eligible.
pub(crate) fn entry_is_locatable(entry: &RefEntry) -> bool {
    window_rooted(entry) && !entry_is_unverifiable(entry)
}

/// Whether the stored child-index path may be walked as a fast path.
///
/// Mirrors macOS's `can_use_path_fast_path`: [`entry_is_locatable`] plus a
/// non-empty path.
pub(crate) fn can_use_path_fast_path(entry: &RefEntry) -> bool {
    entry_is_locatable(entry) && !entry.scope.path.is_empty()
}

/// Walks the stored child-index path from a root, O(depth) child reads.
///
/// Hands back both of [`descent::PathLanding`]'s facts unfolded, which is the
/// whole reason it returns a landing rather than an element and an
/// incompleteness output parameter. The landing is what
/// [`accept_path_landing`] decides on; the unread region is what an attempt's
/// *negative* verdict is withheld by. Merging them into one flag makes an
/// accepted landing look like it ignored an obligation, and makes a dropped
/// region look like a tidy scope.
///
/// A path step that lands nowhere yields no element; the caller treats that as
/// a miss and falls back to the broad search, never as a verdict that the
/// target is gone.
///
/// Generic over the tree source so the two are separable: what a gap on this
/// walk means to the resolution as a whole can be exercised without a live UI
/// Automation provider to fault on demand.
pub(crate) fn walk_stored_path<S: TreeSource>(
    source: &S,
    root: &S::Node,
    path: &[usize],
    budget: &WalkBudget,
) -> Result<descent::PathLanding<S::Node>, AdapterError> {
    descent::descend_path(source, root, path, budget, &SEARCH_DESCENT)
}

/// Decides the element the stored path landed on, from that element's own
/// evidence and nothing else.
///
/// The signature is the argument. This tier is handed the element the path
/// names and the ref it is matched against, and no completeness of the
/// surrounding walk is in scope for it to consult. That is a property, not an
/// omission: a landing is the element the stored path names whatever else the
/// walk failed to read (see [`descent::PathLanding`]), and the claim this tier
/// makes is positional - the ref named *this* location and the element there
/// still answers to the stored identity - never a uniqueness claim over the
/// tree. Uniqueness is the broad search's claim to make, and a ref this tier
/// declines falls through to it.
///
/// Declining is therefore never a verdict. `None` says only that this tier
/// could not settle the match, and the attempt continues.
///
/// The admission rule is [`admit_node`] itself rather than a second copy of
/// the role gate, the composed identity rule and the geometry promotion, so
/// the two tiers cannot drift into accepting different elements. One check
/// sits ahead of it: [`geometry_contradicts`] refutes a landing whose live
/// bounds hash disagrees with a known stored one even when `admit_node`'s
/// identity tiers alone would call it a match - role and name survive a list
/// reordering, a stored bounds hash does not, so this tier must not return
/// early on identity alone and pre-empt the broad search's own bounds
/// tie-break.
pub(crate) fn accept_path_landing(
    source: &UiaTreeSource,
    candidate: &UIAElement,
    entry: &RefEntry,
) -> Option<UIAElement> {
    let (_, evidence, _) = source.evidence(candidate);
    if geometry_contradicts(entry, &evidence) {
        return None;
    }
    match admit_node(entry, &evidence) {
        NodeAdmission::Collect => Some(candidate.clone()),
        NodeAdmission::Unread | NodeAdmission::Reject => None,
    }
}

/// The geometry promotion eligibility predicate.
///
/// Mirrors macOS's `provisional_geometry_candidate` with one
/// Windows-measured addition: the stored bounds hash must come from a
/// positive-area rectangle (A17-7 - offscreen and virtualized elements
/// collapse to shared zero-extent bounds that are structurally non-unique),
/// and the stored bounds must agree. A ref with no meaningful text identity
/// and a zero-extent stored hash is unresolvable by design and never promotes.
pub(crate) fn provisional_geometry_candidate(entry: &RefEntry) -> bool {
    entry.geometry.bounds_hash.is_some()
        && entry
            .geometry
            .bounds
            .is_some_and(|rect| rect.width > 0.0 && rect.height > 0.0)
        && !has_meaningful_identity(entry)
}

/// Whether a candidate's live bounds hash matches the stored one under the
/// promotion's eligibility rules - the unique-geometry-match that promotes an
/// otherwise-unreadable candidate to resolved.
pub(crate) fn geometry_matches(entry: &RefEntry, evidence: &LocatorEvidence) -> bool {
    provisional_geometry_candidate(entry) && bounds_hash_of(evidence) == entry.geometry.bounds_hash
}

/// Whether the stored bounds hash and a candidate's live bounds hash are both
/// known and disagree.
///
/// Deliberately not [`geometry_matches`]: that predicate is gated by
/// [`provisional_geometry_candidate`], which requires
/// `!has_meaningful_identity(entry)` - it exists to promote an otherwise
/// unreadable candidate, not to refute an identity-matched one, so it always
/// answers `false` for a ref that carries a name or an id, which is exactly
/// the shape (duplicate-identity siblings sharing role, name and
/// `AutomationId`) this refutation exists to catch. An unknown hash on either
/// side answers `false` here, never a refutation - the resolver's tri-state
/// discipline treats an unread field as `Unread`, not as evidence of absence.
pub(crate) fn geometry_contradicts(entry: &RefEntry, evidence: &LocatorEvidence) -> bool {
    match (entry.geometry.bounds_hash, bounds_hash_of(evidence)) {
        (Some(stored), Some(live)) => stored != live,
        _ => false,
    }
}

/// Whether the stored ref carries nothing any resolution tier could ever
/// verify a live candidate against: no id, no stable text, and no
/// positive-area bounds hash for the geometry tier to promote on.
///
/// Meant to be checked once over the entry before the walk runs, because no
/// amount of successful reading changes the answer for this class: with no
/// stored name, value or description, core's `stable_text_match` has no
/// `expected` text to equality-match against, so it can only ever fall
/// through to `empty_identity_match` over the live candidate's own fields -
/// which resolves `NoMatch` the instant any of them reads back `Known`, and
/// `Unknown` only when none of them do. `IdentityMatch::Match` is therefore
/// unreachable for this class no matter what the walk reads, so an unbounded
/// walk would spend a full attempt - refuting some candidates, marking
/// others incomplete - reaching a verdict the entry alone already settles.
pub(crate) fn entry_is_unverifiable(entry: &RefEntry) -> bool {
    !has_meaningful_identity(entry) && !provisional_geometry_candidate(entry)
}

/// Whether an already-collected match count settles `AMBIGUOUS_TARGET` on
/// its own, with nothing left to read that could change the answer.
///
/// Despite the name, nothing here stops `search_under`'s own walk early -
/// Windows's search always collects the whole depth-bounded subtree, and
/// this predicate is consulted only after collection finishes, inside
/// `classify_search`. Two or more matches with no stored hash to
/// disambiguate is conclusively ambiguous already: nothing left unread could
/// turn it into anything other than `AMBIGUOUS_TARGET`, so an incomplete
/// region elsewhere in the tree must not withhold that verdict. Mirrors
/// macOS's `should_stop_collecting`
/// (`crates/macos/src/tree/resolve/resolve_search.rs:374-376`), which does stop its
/// walk early on this signal - Windows only reuses its name and its
/// classification rule, not its early exit.
pub(crate) fn should_stop_collecting(match_count: usize, entry: &RefEntry) -> bool {
    match_count > 1 && entry.geometry.bounds_hash.is_none()
}

/// Bundles the three values that stay invariant across `search_under`'s
/// recursive descent - the tree source, the stored ref being resolved
/// against, and the walk budget - so the recursive signature threads one
/// reference instead of carrying each individually at every call.
pub(crate) struct SearchContext<'a> {
    pub(crate) source: &'a UiaTreeSource,
    pub(crate) entry: &'a RefEntry,
    pub(crate) budget: &'a WalkBudget,
}

/// Whether a child at `depth + 1` would still be within the resolve depth
/// cap and therefore actually get searched.
///
/// Enumeration is gated on this rather than run unconditionally: at
/// `depth + 1 == MAX_RESOLVE_DEPTH`, every child the enumeration would
/// return is immediately discarded by the depth guard on entry to the next
/// call, so running the enumeration first pays a real, cross-process
/// sibling walk (up to the sibling cap) purely for children the search will
/// never evaluate. Skipping the enumeration also means a transport failure
/// among those never-searched children can no longer flag the search
/// incomplete - correctly so: nothing this search will ever look at can be
/// the reason to retry it, so the retry would buy nothing.
fn child_search_is_reachable(depth: u8) -> bool {
    depth + 1 < MAX_RESOLVE_DEPTH
}

/// What the search does with one node it has read.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum NodeAdmission {
    /// The node is a candidate the verdict counts.
    Collect,
    /// The node's own evidence could not settle the question, so this region
    /// of the tree was not read conclusively and the verdict is withheld.
    Unread,
    /// The node is refuted, or its role rules it out. Nothing is withheld.
    Reject,
}

/// Decides one node's admission from the stored ref and the node's evidence:
/// the role gate, the composed identity rule, and the geometry promotion.
///
/// Pure over evidence rather than over a live element, so each arm is
/// decidable without a UI Automation provider that can be made to withhold a
/// property on demand - the separation `select_by_bounds_hash` already draws
/// for the tie-break.
///
/// The promotion arm is reachable only on an `Incomplete` identity, and for
/// the class it exists to serve that verdict is structural rather than
/// transient: a ref whose role carries a mutable value and whose stored text
/// is blank - the shape a secure edit stores - makes core's
/// `stable_text_match` answer `Unknown` on every attempt, whatever the read
/// succeeds at. Geometry is the only tier that class has, and only from a
/// positive-area rectangle: offscreen and virtualized elements collapse to
/// shared zero-extent bounds that are structurally non-unique (A17-7), so a
/// zero-extent stored rectangle leaves the node unread rather than promoting
/// it. An unpromoted `Incomplete` is never a refutation - the tri-state
/// discipline the whole resolver is built on.
pub(crate) fn admit_node(entry: &RefEntry, evidence: &LocatorEvidence) -> NodeAdmission {
    let role_matches = evidence
        .role
        .known()
        .is_some_and(|role| role == &entry.identity.role);
    if !role_matches {
        if evidence.role.is_unknown() {
            return NodeAdmission::Unread;
        }
        return NodeAdmission::Reject;
    }
    match super::resolve_match::candidate_outcome(entry, evidence) {
        CandidateOutcome::Matched => NodeAdmission::Collect,
        CandidateOutcome::Incomplete if geometry_matches(entry, evidence) => NodeAdmission::Collect,
        CandidateOutcome::Incomplete => NodeAdmission::Unread,
        CandidateOutcome::Refuted => NodeAdmission::Reject,
    }
}

/// Searches the subtree under `element` to the resolve depth, collecting the
/// candidates the composed matcher accepted and recording every part of the
/// subtree it could not read.
pub(crate) fn search_under(
    ctx: &SearchContext<'_>,
    element: &UIAElement,
    depth: u8,
    out: &mut Vec<Candidate>,
    unread_region: &mut bool,
) -> Result<(), AdapterError> {
    if depth >= MAX_RESOLVE_DEPTH {
        return Ok(());
    }
    ctx.budget.deadline.ensure_remaining()?;

    let (_, evidence, _) = ctx.source.evidence(element);
    match admit_node(ctx.entry, &evidence) {
        NodeAdmission::Collect => out.push(build_candidate(element, &evidence)),
        NodeAdmission::Unread => *unread_region = true,
        NodeAdmission::Reject => {}
    }

    if child_search_is_reachable(depth) {
        let children = enumerate_children(ctx.source, element, ctx.budget, unread_region)?;
        for child in children {
            search_under(ctx, &child, depth + 1, out, unread_region)?;
        }
    }
    Ok(())
}

/// Enumerates one element's children for the search, honouring the sibling cap
/// as a hard bound on pathological lists.
pub(crate) fn enumerate_children(
    source: &UiaTreeSource,
    element: &UIAElement,
    budget: &WalkBudget,
    unread_region: &mut bool,
) -> Result<Vec<UIAElement>, AdapterError> {
    let read = descent::read_children(source, element, budget, &SEARCH_DESCENT, None)?;
    *unread_region |= !read.complete;
    Ok(read.elements)
}

/// The search's descent policy.
///
/// An expired deadline leaves the search unfinished rather than surfacing:
/// unfinished is exactly what the search's own classification already means by
/// retryable, and the search did not finish, so a partial collection must not
/// be classified as a settled absence.
pub(crate) const SEARCH_DESCENT: DescentPolicy = DescentPolicy {
    classify: search_descent_verdict,
    on_expiry: ExpiryPolicy::Unfinish,
    descend_context: "descend to a stored ref",
    sibling_context: "walk a stored ref's siblings",
};

/// Classifies a descent failure under the read disposition: a settled
/// absence means the node enumerates nothing (a real answer, not
/// incomplete); a transport failure or vanished node marks the search
/// incomplete and the descent continues - a non-target node dying
/// mid-descent under live churn is not evidence the target is gone; a
/// terminal failure propagates.
fn search_descent_verdict(failure: UiaFailure) -> DescentVerdict {
    match uia_failure_disposition(failure) {
        ReadDisposition::SettledAbsence => DescentVerdict::Settled,
        ReadDisposition::Retryable | ReadDisposition::Unavailable => DescentVerdict::Unfinished,
        ReadDisposition::Terminal => DescentVerdict::Surfaced,
    }
}

/// Builds the candidate from the walk-composed evidence the search already
/// read, projecting the tie-break hash off the same evidence slot.
pub(crate) fn build_candidate(element: &UIAElement, evidence: &LocatorEvidence) -> Candidate {
    Candidate {
        element: element.clone(),
        bounds_hash: bounds_hash_of(evidence),
    }
}

#[cfg(all(test, target_os = "windows"))]
#[path = "resolve_search_tests.rs"]
mod tests;

#[cfg(all(test, target_os = "windows"))]
#[path = "resolve_search_admission_tests.rs"]
mod admission_tests;
