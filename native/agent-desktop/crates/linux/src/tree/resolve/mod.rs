use agent_desktop_core::refs::ref_identity::has_meaningful_identity;
use agent_desktop_core::refs::resolve_errors::identity_unknown_error;
use agent_desktop_core::{
    AdapterError, Deadline, ErrorCode, LocatorEvidence, LocatorField, Rect, RefEntry,
};

use super::AtspiElement;
use super::resolve::candidate::{Candidate, without_nested_relatives};
use super::resolve::landing::Landing;
use super::resolve::path_descent::descend;
use super::resolve::resolution::Verdict;
use super::resolve::resolve_errors::{
    ambiguous, descendant_owner_gone, is_incomplete, no_candidate, settle_gone, stopped_aware,
    unverifiable_entry,
};
use super::resolve::resolve_identity::classify;
use super::resolve::resolve_identity::entry_is_unverifiable;
use super::resolve::searched::Searched;
use super::walk::level::Level;
use super::walk::walker_expand::UNKNOWN_PID;

/// What a resolution reads. The bus implements it; a test substitutes an
/// in-memory tree and counts the reads.
pub(crate) trait Source {
    /// The verified root of the ref's surface, carrying its window ancestry.
    fn open_window(&mut self, entry: &RefEntry) -> Result<AtspiElement, AdapterError>;
    /// The children of one node, in the order a walk records them.
    fn level(&mut self, element: &AtspiElement) -> Result<Level<AtspiElement>, AdapterError>;
    /// The evidence of one node, read as the snapshot walk reads it.
    fn evidence(&mut self, element: &AtspiElement) -> Result<LocatorEvidence, AdapterError>;
    /// Every node under the frame, evaluated against the stored evidence.
    fn search(&mut self, frame: &AtspiElement, entry: &RefEntry) -> Result<Searched, AdapterError>;
    /// The listed name of the application when `/proc` shows it stopped.
    fn stopped_app(&mut self, pid: u32) -> Option<String>;
}

pub(super) fn settle_read_error<S: Source>(
    source: &mut S,
    entry: &RefEntry,
    element: &AtspiElement,
    error: AdapterError,
) -> AdapterError {
    if error.code != ErrorCode::AppNotFound
        || element
            .frame()
            .is_none_or(|frame| frame.bus_name() == element.bus_name())
    {
        return error;
    }
    match source.open_window(entry) {
        Ok(_) => descendant_owner_gone(element, error),
        Err(error) => error,
    }
}

/// Whether the stored path is scoped to the window root rather than to a
/// drill-down ancestor.
fn window_rooted(entry: &RefEntry) -> bool {
    entry.scope.root_ref.is_none() || entry.scope.path_is_absolute
}

/// A retained object is an address no other node holds, so the search finds
/// the one node or none and the stored path adds no region to read. Following
/// the path costs one sequential round trip per level, which a slow
/// application answers one at a time.
fn path_tier_applies(entry: &RefEntry) -> bool {
    window_rooted(entry) && !entry.scope.path.is_empty() && entry.identity.retained_object.is_none()
}

/// Whether the stored path leaves a region unread. Its landing never
/// authorizes resolution: the search decides. A destroyed landing is settled
/// gone and leaves no region unread; any other failed read does.
fn path_tier<S: Source>(
    source: &mut S,
    frame: &AtspiElement,
    entry: &RefEntry,
    deadline: Deadline,
) -> Result<bool, AdapterError> {
    let landing = descend(frame.clone(), &entry.scope.path, deadline, |element| {
        let outcome = source.level(element);
        outcome.map_err(|error| settle_read_error(source, entry, element, error))
    })?;
    let Landing { element, unread } = landing;
    let Some(element) = element.filter(|element| element.pid() != UNKNOWN_PID) else {
        return Ok(unread);
    };
    let evidence = source.evidence(&element);
    match evidence.map_err(|error| settle_read_error(source, entry, &element, error)) {
        Ok(_) => Ok(unread),
        Err(error)
            if matches!(
                error.code,
                ErrorCode::AppNotFound | ErrorCode::Timeout | ErrorCode::StaleRef
            ) =>
        {
            Err(error)
        }
        Err(error) if error.code == ErrorCode::ElementNotFound => Ok(false),
        Err(_) => Ok(true),
    }
}

/// The verified window frame, when the ref stored an empty path and the frame
/// answers to the stored evidence. The gate has proved the process and the
/// window, and exactly one node sits at depth zero, so no twin can exist
/// elsewhere in the tree and an unread region below it (a background tab's
/// document lists no children) cannot change the answer.
fn frame_candidate<'a>(candidates: &'a [Candidate], entry: &RefEntry) -> Option<&'a Candidate> {
    if !window_rooted(entry) || !entry.scope.path.is_empty() {
        return None;
    }
    candidates.iter().find(|candidate| candidate.depth == 0)
}

fn attempt<S: Source>(
    source: &mut S,
    entry: &RefEntry,
    deadline: Deadline,
) -> Result<AtspiElement, AdapterError> {
    if entry_is_unverifiable(entry) {
        return Err(unverifiable_entry());
    }
    if deadline.is_expired() {
        return Err(deadline.timeout_error());
    }
    let frame = source.open_window(entry)?;
    let path_unread = if path_tier_applies(entry) {
        path_tier(source, &frame, entry, deadline)?
    } else {
        false
    };
    let mut searched = source.search(&frame, entry)?;
    if path_tier_applies(entry) {
        without_nested_relatives(&mut searched.candidates, &entry.scope.path);
    }
    let rects: Vec<LocatorField<Rect>> = searched
        .candidates
        .iter()
        .map(|candidate| candidate.bounds.clone())
        .collect();
    let spaces: Vec<agent_desktop_core::BoundsSpace> = searched
        .candidates
        .iter()
        .map(|candidate| candidate.bounds_space)
        .collect();
    if let Some(frame) = frame_candidate(&searched.candidates, entry) {
        return Ok(frame.element.clone());
    }
    let unread = path_unread || searched.unread_region;
    match classify(
        &rects,
        &spaces,
        has_meaningful_identity(entry).then_some(&entry.geometry),
        unread,
    ) {
        Verdict::Resolved(index) => searched
            .candidates
            .into_iter()
            .nth(index)
            .map(|candidate| candidate.element)
            .ok_or_else(no_candidate),
        Verdict::Stale => Err(no_candidate()),
        Verdict::Ambiguous => Err(ambiguous(searched.candidates.len())),
        Verdict::Incomplete => Err(identity_unknown_error(entry)),
    }
}

/// Resolves a stored ref to the live element it was taken from, or refuses.
/// A ref with no identity evidence is refused before any read: a child index
/// cannot distinguish an unnamed node from a replacement or reordered sibling.
/// The window gate proves the process and window are the stored ones. Every
/// ref also searches the bounded window tree: a positional landing cannot
/// prove that no matching sibling exists.
/// An application that left, a destroyed object and a timeout are told apart
/// at this boundary, and a timeout on a stopped process is `APP_UNRESPONSIVE`.
pub(crate) fn resolve<S: Source>(
    source: &mut S,
    entry: &RefEntry,
    deadline: Deadline,
) -> Result<AtspiElement, AdapterError> {
    if let Some(name) = source.stopped_app(entry.process.pid.get()) {
        return Err(AdapterError::app_unresponsive(&name));
    }
    let outcome = attempt(source, entry, deadline);
    settle_outcome(source, entry, outcome)
}

/// Maps the end of one attempt to the answer the caller gets: an application
/// that left and a destroyed object are settled refusals, and a timeout on a
/// stopped process is `APP_UNRESPONSIVE`.
pub(super) fn settle_outcome<S: Source>(
    source: &mut S,
    entry: &RefEntry,
    outcome: Result<AtspiElement, AdapterError>,
) -> Result<AtspiElement, AdapterError> {
    outcome.map_err(|error| {
        let error = settle_gone(error, entry.process.pid.get());
        if error.code == ErrorCode::Timeout || is_incomplete(&error) {
            let stopped = source.stopped_app(entry.process.pid.get());
            stopped_aware(error, stopped.as_deref())
        } else {
            error
        }
    })
}

pub(super) mod candidate;
pub(super) mod landing;
pub(super) mod path_descent;
pub(super) mod resolution;
pub(super) mod resolve_anchor;
pub(super) mod resolve_candidates;
pub(super) mod resolve_errors;
#[cfg(test)]
pub(super) mod resolve_fake;
pub(super) mod resolve_gate;
pub(super) mod resolve_identity;
pub(super) mod resolve_search;
pub(super) mod resolve_source;
pub(super) mod searched;
#[cfg(test)]
#[path = "resolve_tests.rs"]
mod tests;

#[cfg(test)]
#[path = "resolve_depth_tests.rs"]
mod depth_tests;

#[cfg(test)]
#[path = "resolve_refusal_tests.rs"]
mod refusal_tests;

#[cfg(test)]
#[path = "resolve_web_tests.rs"]
mod web_tests;

#[cfg(test)]
#[path = "resolve_shift_tests.rs"]
mod shift_tests;

#[cfg(test)]
#[path = "resolve_nested_tests.rs"]
mod nested_tests;
