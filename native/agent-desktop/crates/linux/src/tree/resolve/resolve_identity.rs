use agent_desktop_core::{
    BoundsSpace, IdentityMatch, LocatorEvidence, LocatorField, Rect, RefEntry, RefGeometry,
    refs::ref_identity::{
        has_meaningful_identity, has_stable_text_identity, identity_match, stable_text_match,
    },
};

use super::resolution::Verdict;
use crate::tree::walk::admission::Admission;

/// The width and height of a rectangle that has an area. A zero or negative
/// side is no size: GTK4 containers often report a zero axis, and `-1` is how
/// a toolkit says it has no extents.
pub(crate) fn usable_size(rect: &Rect) -> Option<(f64, f64)> {
    (rect.width > 0.0 && rect.height > 0.0).then_some((rect.width, rect.height))
}

/// The identity verdict. An identifier match alone would settle an
/// identifier-bearing ref, but an identifier can be shared (Qt list rows share
/// their list's) or reused by a different element, so when the ref also
/// carries stable text the text must agree: an identifier match with a text
/// mismatch is a refutation, and an unreadable text is never a mismatch.
pub(crate) fn identity_verdict(entry: &RefEntry, evidence: &LocatorEvidence) -> IdentityMatch {
    let by_identifier = identity_match(
        entry,
        &evidence.name,
        &evidence.value,
        &evidence.description,
        &evidence.identifiers,
    );
    if entry.identity.native_id.is_some()
        && by_identifier == IdentityMatch::Match
        && has_stable_text_identity(entry)
    {
        return stable_text_match(
            entry,
            &evidence.name,
            &evidence.value,
            &evidence.description,
        );
    }
    by_identifier
}

/// Whether a ref with no identity carries a usable rectangle: it
/// stored a rectangle with an area and has no identifier or stable text. A
/// zero-area rectangle is shared by every collapsed or virtualised element
/// and identifies nothing.
pub(crate) fn provisional_geometry_candidate(entry: &RefEntry) -> bool {
    entry
        .geometry
        .bounds
        .as_ref()
        .and_then(usable_size)
        .is_some()
        && !has_meaningful_identity(entry)
}

/// Whether geometry alone proves the same rectangle in its recorded frame.
fn geometry_matches(entry: &RefEntry, evidence: &LocatorEvidence) -> bool {
    provisional_geometry_candidate(entry) && rectangles_match(entry, evidence) == Some(true)
}

pub(crate) fn stored_space(entry: &RefEntry) -> BoundsSpace {
    entry.geometry.bounds_space.unwrap_or_default()
}

fn bounds_in(evidence: &LocatorEvidence, space: BoundsSpace) -> &LocatorField<Rect> {
    match space {
        BoundsSpace::Window => &evidence.ref_evidence.window_bounds,
        BoundsSpace::Screen => &evidence.ref_evidence.bounds,
    }
}

pub(in crate::tree) fn candidate(
    entry: &RefEntry,
    evidence: &LocatorEvidence,
    element: crate::tree::AtspiElement,
    path: &[usize],
) -> super::candidate::Candidate {
    let mut candidate = super::candidate::Candidate {
        element,
        bounds: bounds_in(evidence, stored_space(entry)).clone(),
        bounds_space: stored_space(entry),
        depth: path.len(),
        path: path.to_vec(),
    };
    if matches!(
        bounds_in(evidence, stored_space(entry)),
        LocatorField::Absent
    ) {
        let other = match candidate.bounds_space {
            BoundsSpace::Window => BoundsSpace::Screen,
            BoundsSpace::Screen => BoundsSpace::Window,
        };
        if let Some(bounds) = bounds_in(evidence, other).known() {
            candidate.bounds = LocatorField::Known(*bounds);
            candidate.bounds_space = other;
        }
    }
    candidate
}

fn rectangles_match(entry: &RefEntry, evidence: &LocatorEvidence) -> Option<bool> {
    entry
        .geometry
        .bounds
        .as_ref()
        .filter(|rect| usable_size(rect).is_some())
        .zip(
            bounds_in(evidence, stored_space(entry))
                .known()
                .copied()
                .filter(|rect| usable_size(rect).is_some()),
        )
        .map(|(stored, live)| stored == &live)
}

/// Whether the stored and live evidence describe unequal rectangles.
/// Both position and size must agree in the
/// recorded frame. An unknown rectangle on either side refutes nothing.
pub(crate) fn geometry_contradicts(entry: &RefEntry, evidence: &LocatorEvidence) -> bool {
    rectangles_match(entry, evidence) == Some(false)
}

/// Whether nothing any tier could verify a live node against is stored: no
/// identifier, no stable text and no rectangle with an area.
pub(crate) fn entry_is_unverifiable(entry: &RefEntry) -> bool {
    !has_meaningful_identity(entry) && !provisional_geometry_candidate(entry)
}

/// Decides one node's admission from the stored ref and the node's evidence:
/// the role gate, the composed identity rule and the whole rectangle. An
/// unreadable role or identity leaves the region unread and is never a
/// refutation. A ref that can only be recognised by geometry is refuted by a
/// node whose rectangle was read and differs: it is not unread, since nothing more
/// could be learned about that node.
pub(crate) fn admit_node(entry: &RefEntry, evidence: &LocatorEvidence) -> Admission {
    if entry.identity.retained_object.is_some() && geometry_contradicts(entry, evidence) {
        return Admission::Reject;
    }
    match evidence.role.known() {
        None if evidence.role.is_unknown() => return Admission::Unread,
        Some(role) if role == &entry.identity.role => {}
        _ => return Admission::Reject,
    }
    match identity_verdict(entry, evidence) {
        IdentityMatch::Match => Admission::Collect,
        IdentityMatch::Unknown if geometry_matches(entry, evidence) => Admission::Collect,
        IdentityMatch::Unknown
            if provisional_geometry_candidate(entry)
                && !bounds_in(evidence, stored_space(entry)).is_unknown() =>
        {
            Admission::Reject
        }
        IdentityMatch::Unknown => Admission::Unread,
        IdentityMatch::NoMatch => Admission::Reject,
    }
}

/// The one candidate whose rectangle or compact snapshot hash matches in its recorded frame.
/// It only ever picks among several candidates and never refutes one; a ref
/// with no stored size cannot be separated this way and stays ambiguous. A
/// candidate whose extents were not read is not a size that differs: it could
/// be the element, so while any candidate is unread nothing is picked.
pub(crate) fn select_by_stored_geometry(
    candidates: &[LocatorField<Rect>],
    spaces: &[BoundsSpace],
    stored: &RefGeometry,
) -> Option<usize> {
    if candidates.iter().any(LocatorField::is_unknown) {
        return None;
    }
    if spaces.len() != candidates.len()
        || candidates.iter().zip(spaces).any(|(bounds, space)| {
            bounds.known().is_some() && *space != stored.bounds_space.unwrap_or_default()
        })
    {
        return None;
    }
    let mut matching = candidates.iter().enumerate().filter_map(|(index, rect)| {
        let rect = rect.known()?;
        let same = usable_size(rect).is_some()
            && match stored.bounds {
                Some(bounds) => usable_size(&bounds).is_some() && rect == &bounds,
                None => stored.bounds_hash.is_some() && rect.bounds_hash() == stored.bounds_hash,
            };
        same.then_some(index)
    });
    let first = matching.next()?;
    matching.next().is_none().then_some(first)
}

/// Classifies the candidates a search collected. Two or more candidates with
/// no usable stored size are ambiguous whatever else is unread, because no
/// unread region can make them anything else. Below that, an unread region
/// withholds every verdict, so a lone match found while another region could
/// not be read is retried and not resolved.
pub(crate) fn classify(
    candidates: &[LocatorField<Rect>],
    spaces: &[BoundsSpace],
    stored: Option<&RefGeometry>,
    unread_region: bool,
) -> Verdict {
    let separable = stored.is_some_and(|geometry| match geometry.bounds {
        Some(bounds) => usable_size(&bounds).is_some(),
        None => geometry.bounds_hash.is_some(),
    });
    if candidates.len() > 1 && !separable {
        return Verdict::Ambiguous;
    }
    let extents_unread = candidates.len() > 1 && candidates.iter().any(LocatorField::is_unknown);
    if unread_region || extents_unread {
        return Verdict::Incomplete;
    }
    match candidates.len() {
        0 => Verdict::Stale,
        1 => Verdict::Resolved(0),
        _ => stored
            .and_then(|stored| select_by_stored_geometry(candidates, spaces, stored))
            .map_or(Verdict::Ambiguous, Verdict::Resolved),
    }
}

#[cfg(test)]
#[path = "resolve_match_tests.rs"]
mod match_tests;

#[cfg(test)]
#[path = "resolve_verdict_tests.rs"]
mod verdict_tests;
