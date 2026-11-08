use agent_desktop_core::{
    AdapterError, NativeHandle, RefEntry, refs::ref_identity::has_meaningful_identity,
};

#[cfg(target_os = "macos")]
use super::resolve_bounds::bounds_match_with_deadline;
use crate::tree::AXElement;

#[cfg(target_os = "macos")]
pub(in crate::tree) fn classify_candidates(
    mut matches: Vec<AXElement>,
    entry: &RefEntry,
    source_window_verified: bool,
    deadline: std::time::Instant,
) -> Result<NativeHandle, AdapterError> {
    match matches.len() {
        0 => Err(AdapterError::element_not_found("element")),
        1 => {
            let candidate = matches.remove(0);
            if candidate_is_sufficiently_verified(
                &candidate,
                entry,
                source_window_verified,
                deadline,
            )? {
                retained_handle(candidate)
            } else {
                Err(AdapterError::element_not_found("element"))
            }
        }
        _ => classify_ambiguous_candidates(matches, entry, deadline),
    }
}

#[cfg(target_os = "macos")]
fn candidate_is_sufficiently_verified(
    candidate: &AXElement,
    entry: &RefEntry,
    source_window_verified: bool,
    deadline: std::time::Instant,
) -> Result<bool, AdapterError> {
    if source_window_verified && !candidate_requires_bounds(entry) {
        return Ok(true);
    }
    verified_bounds_match(candidate, entry, deadline)
}

fn candidate_requires_bounds(entry: &RefEntry) -> bool {
    !has_meaningful_identity(entry)
}

#[cfg(target_os = "macos")]
fn verified_bounds_match(
    candidate: &AXElement,
    entry: &RefEntry,
    deadline: std::time::Instant,
) -> Result<bool, AdapterError> {
    if entry.geometry.bounds_hash.is_none() {
        return Ok(false);
    }
    bounds_match_with_deadline(candidate, entry, deadline)
}

#[cfg(target_os = "macos")]
fn classify_ambiguous_candidates(
    matches: Vec<AXElement>,
    entry: &RefEntry,
    deadline: std::time::Instant,
) -> Result<NativeHandle, AdapterError> {
    let has_bounds_hash = entry.geometry.bounds_hash.is_some();
    let mut bounds_matches = Vec::new();
    if has_bounds_hash {
        for candidate in &matches {
            if verified_bounds_match(candidate, entry, deadline)? {
                bounds_matches.push(candidate.clone());
            }
        }
    }
    match classify_bounds_matches(bounds_matches.len(), has_bounds_hash) {
        BoundsMatchOutcome::Resolved => retained_handle(bounds_matches.remove(0)),
        BoundsMatchOutcome::Stale => Err(stale_ref_from_bounds_mismatch(entry, matches.len())),
        BoundsMatchOutcome::Ambiguous => Err(ambiguous_target_error(&matches, entry)),
    }
}

#[derive(Debug, PartialEq, Eq)]
pub(in crate::tree) enum BoundsMatchOutcome {
    Resolved,
    Stale,
    Ambiguous,
}

pub(in crate::tree) fn classify_bounds_matches(
    bounds_match_count: usize,
    has_bounds_hash: bool,
) -> BoundsMatchOutcome {
    if !has_bounds_hash {
        return BoundsMatchOutcome::Ambiguous;
    }
    match bounds_match_count {
        0 => BoundsMatchOutcome::Stale,
        1 => BoundsMatchOutcome::Resolved,
        _ => BoundsMatchOutcome::Ambiguous,
    }
}

#[cfg(target_os = "macos")]
fn stale_ref_from_bounds_mismatch(entry: &RefEntry, candidate_count: usize) -> AdapterError {
    AdapterError::stale_ref_because(format!(
        "No live candidate matched the saved element's bounds: \
         {candidate_count} shared its identity, none its geometry"
    ))
    .with_details(serde_json::json!({
        "kind": "bounds_mismatch",
        "candidate_count": candidate_count,
        "identity": identity_summary_for_message(entry),
    }))
}

#[cfg(target_os = "macos")]
fn ambiguous_target_error(matches: &[AXElement], entry: &RefEntry) -> AdapterError {
    let count = matches.len();
    AdapterError::ambiguous_target(format!(
        "Ambiguous target: {count} candidates matched {}",
        identity_summary_for_message(entry)
    ))
    .with_details(serde_json::json!({
        "candidate_count": count,
        "candidate_summaries_truncated": count > 10,
        "role": entry.identity.role,
        "name": entry.identity.name,
        "description": entry.identity.description,
        "source_app": entry.source.source_app,
        "source_window_id": entry.source.source_window_id,
        "source_window_title": entry.source.source_window_title,
        "candidates": candidate_summaries(matches, entry)
    }))
}

#[cfg(target_os = "macos")]
pub(in crate::tree) fn identity_summary_for_message(entry: &RefEntry) -> String {
    format!(
        "role={}, name_chars={}, description_chars={}",
        entry.identity.role,
        text_len(entry.identity.name.as_deref()),
        text_len(entry.identity.description.as_deref())
    )
}

#[cfg(target_os = "macos")]
fn text_len(value: Option<&str>) -> usize {
    value.unwrap_or("").chars().count()
}

#[cfg(target_os = "macos")]
fn retained_handle(candidate: AXElement) -> Result<NativeHandle, AdapterError> {
    if candidate.0.is_null() {
        #[cfg(test)]
        return Ok(NativeHandle::null());
        #[cfg(not(test))]
        return Err(AdapterError::element_not_found("element"));
    }
    Ok(candidate.into_native_handle())
}

#[cfg(target_os = "macos")]
fn candidate_summaries(matches: &[AXElement], entry: &RefEntry) -> Vec<serde_json::Value> {
    matches
        .iter()
        .take(10)
        .enumerate()
        .map(|(index, _)| {
            serde_json::json!({
                "index": index,
                "role": entry.identity.role,
                "identity": "matched",
            })
        })
        .collect()
}
