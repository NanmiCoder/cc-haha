use agent_desktop_core::{AdapterError, Deadline, ErrorCode, NativeHandle, RefEntry};

#[cfg(target_os = "windows")]
use super::resolve::resolve_pacing::{FIRST_RETRY_PAUSE, next_retry_pause, sleep_before_retry};

#[cfg(target_os = "windows")]
use super::element::UIAElement;
#[cfg(target_os = "windows")]
use super::resolve::resolve_chrome_repair::repair_past_leading_chrome;
#[cfg(all(test, target_os = "windows"))]
use super::resolve::resolve_match::CandidateOutcome;
use super::resolve::resolve_match::stale_ref_error;
#[cfg(target_os = "windows")]
use super::resolve::resolve_match::{ambiguous_target_error, owning_process_exited_error};
#[cfg(target_os = "windows")]
use super::resolve::resolve_search::descent::PathLanding;
#[cfg(target_os = "windows")]
use super::resolve::resolve_search::{
    SearchContext, accept_path_landing, can_use_path_fast_path, entry_is_unverifiable,
    identity_unknown_error, resolve_walk_budget, search_under, should_stop_collecting,
    walk_stored_path,
};
#[cfg(all(test, target_os = "windows"))]
use super::walk::walker::{TreeSource, WalkBudget};
#[cfg(target_os = "windows")]
use super::walk::walker_source::UiaTreeSource;

/// Resolves a stored ref to its live element, fail-closed and three-state.
///
/// The search descends from the stored window's root to a resolve-scoped
/// depth, reading each candidate with the same composition the walk uses
/// (`UiaTreeSource::evidence`), gates on role, and runs core's composed
/// identity rule (`resolve_match::candidate_outcome`). Then:
///
/// - zero candidates and every decision was readable -> `STALE_REF`, settled
/// - zero candidates but one was **unreadable** -> incomplete-and-retryable
///   (`AppUnresponsive`, the three-state discipline: an `Unknown` verdict is
///   never a `NoMatch`)
/// - two or more candidates that all match -> `AMBIGUOUS_TARGET`
/// - exactly one -> a `NativeHandle` wrapping the live element
///
/// Anything short of an exact match fails closed rather than guessing,
/// because A7-3 measured Explorer re-resolving 29 of 29 `AutomationId` keys
/// with 5 landing on a different element - the silent-wrong-target shape
/// strictness exists to prevent.
///
/// The whole resolution runs through a `deadline`-bounded retry loop
/// that retries only what is genuinely incomplete - an `AppUnresponsive`
/// error stamped explicitly retryable (an unreadable candidate, a vanished
/// or transient node mid-descent). A settled answer - `STALE_REF` from a
/// completed search, `AMBIGUOUS_TARGET`, a permission denial - is never
/// retried. Every re-attempt re-verifies process liveness through
/// `resolve_window_root` (A14-4's prescribed cure), so a dead process
/// converts to settled `STALE_REF` on the next attempt instead of burning
/// the deadline, and final expiry stamps `deadline_elapsed` onto the last
/// incomplete diagnosis rather than a bare `TIMEOUT` that discards it.
#[cfg(target_os = "windows")]
pub(crate) fn resolve_element_strict(
    entry: &RefEntry,
    deadline: Deadline,
) -> Result<NativeHandle, AdapterError> {
    retry_incomplete_until(deadline, || resolve_attempt(entry, deadline))
}

/// One resolution attempt: the path tier, then the broad search, then the
/// verdict.
///
/// The two tiers report what they left unread separately and keep it separate
/// all the way to [`attempt_verdict`], because a landing and a region are
/// different claims. The path tier's landing is decided by
/// [`accept_path_landing`], which is handed the landed element alone; the
/// region each tier left unread only ever bears on the *negative* verdict, and
/// is composed once, at the end, by the function that settles it.
#[cfg(target_os = "windows")]
fn resolve_attempt(entry: &RefEntry, deadline: Deadline) -> Result<NativeHandle, AdapterError> {
    if entry_is_unverifiable(entry) {
        return Err(stale_ref_error(entry));
    }
    let root = resolve_window_root(entry, deadline)?;
    let source = UiaTreeSource::for_root(&root)?;
    let prepared = source.prepare_root(&root)?;

    let budget = resolve_walk_budget(deadline);

    let path = if can_use_path_fast_path(entry) {
        walk_stored_path(&source, &prepared, &entry.scope.path, &budget)?
    } else {
        PathLanding::not_walked()
    };
    if let Some(accepted) = path
        .element
        .as_ref()
        .and_then(|candidate| accept_path_landing(&source, candidate, entry))
        .or_else(|| repair_past_leading_chrome(&source, &prepared, entry, &budget))
    {
        return Ok(into_verified_handle(accepted, entry));
    }

    let mut searched = Vec::new();
    let mut search_unread_region = false;
    let search_ctx = SearchContext {
        source: &source,
        entry,
        budget: &budget,
    };
    search_under(
        &search_ctx,
        &prepared,
        0,
        &mut searched,
        &mut search_unread_region,
    )?;

    let candidate_hashes: Vec<Option<u64>> = searched
        .iter()
        .map(|candidate| candidate.bounds_hash)
        .collect();
    match attempt_verdict(&candidate_hashes, &path, search_unread_region, entry) {
        SearchVerdict::Incomplete => Err(identity_unknown_error(entry)),
        SearchVerdict::Stale => Err(stale_ref_error(entry)),
        SearchVerdict::Resolved(index) => {
            let Some(candidate) = searched.into_iter().nth(index) else {
                return Err(stale_ref_error(entry));
            };
            Ok(into_verified_handle(candidate.element, entry))
        }
        SearchVerdict::Ambiguous => Err(ambiguous_target_error(entry, searched.len())),
    }
}

/// What the completed (or early-stopped) broad search decided, before a
/// resolved candidate is wired into a live handle.
#[cfg(target_os = "windows")]
enum SearchVerdict {
    /// A candidate or an unrelated region could not be read and the
    /// verdict is not yet settled - the caller retries.
    Incomplete,
    /// No candidate matched and nothing was left unread.
    Stale,
    /// Exactly one candidate settles the match; its index into the
    /// searched list.
    Resolved(usize),
    /// Two or more candidates match and no stored hash disambiguates them.
    Ambiguous,
}

/// Composes every tier's unread region into the one question
/// [`classify_search`] asks - did this attempt read enough of the tree to
/// settle a negative verdict - and classifies the collected candidates
/// against it.
///
/// Takes the path tier's landing itself rather than a bare flag, so the tier's
/// own report is the only thing that can answer for it. A gap met while
/// walking the stored path is a region this attempt did not read, exactly as
/// one met in the broad search is, and the path walk is the only tier that
/// descends past the search's own depth cap - so a gap there can be the sole
/// signal that the tier able to reach the element never got to look. An
/// attempt that dropped it would settle `STALE_REF` - "the element is gone" -
/// off a walk that never finished.
///
/// The landing's own `element` is deliberately unread here. Whether the path
/// found something is settled before this point, by
/// [`super::resolve_search::accept_path_landing`]; what survives to the
/// verdict is only what the walk did not see.
#[cfg(target_os = "windows")]
fn attempt_verdict(
    candidate_hashes: &[Option<u64>],
    path: &PathLanding<UIAElement>,
    search_unread_region: bool,
    entry: &RefEntry,
) -> SearchVerdict {
    classify_search(
        candidate_hashes,
        path.unread_region || search_unread_region,
        entry,
    )
}

/// Composes the searched candidates' tie-break hashes with the unread-region
/// flag into a verdict, mirroring macOS's ordering
/// (`crates/macos/src/tree/resolve/resolve_search.rs:43-58`) even though nothing on
/// Windows stops the search itself early: `search_under` always walks the
/// whole depth-bounded subtree, and `should_stop_collecting` is consulted
/// only here, post-hoc, after collection is done. Two or more matches with
/// no stored hash to disambiguate is checked first, because no unread region
/// could turn an already-conclusive ambiguity into anything else. Only below
/// that threshold does an incomplete region withhold the verdict, so a sole
/// match found while another region of the tree stayed unreadable is
/// retried rather than resolved, and a multi-candidate tie-break with a
/// stored hash still waits on the full picture before it classifies.
/// Because the walk itself never stops early, `ambiguous_target_error`'s
/// candidate count is always the full count found across the entire
/// searched subtree, never a partial one.
#[cfg(target_os = "windows")]
fn classify_search(
    candidate_hashes: &[Option<u64>],
    unread_region: bool,
    entry: &RefEntry,
) -> SearchVerdict {
    let stop_collecting = should_stop_collecting(candidate_hashes.len(), entry);
    if unread_region && !stop_collecting {
        return SearchVerdict::Incomplete;
    }
    match candidate_hashes.len() {
        0 => SearchVerdict::Stale,
        1 => SearchVerdict::Resolved(0),
        _ => match super::resolve::resolve_match::select_by_bounds_hash(
            candidate_hashes,
            entry.geometry.bounds_hash,
        ) {
            super::resolve::resolve_match::Selection::Resolved(index) => {
                SearchVerdict::Resolved(index)
            }
            super::resolve::resolve_match::Selection::Ambiguous => SearchVerdict::Ambiguous,
        },
    }
}

/// Wraps the resolved element with the ref's verified process identity, so the
/// live-read path can corroborate that the provider is still the one
/// resolution verified. The token-less case cannot reach here:
/// `resolve_window_root` fails closed on it first.
#[cfg(target_os = "windows")]
pub(crate) fn into_verified_handle(
    element: super::element::UIAElement,
    entry: &RefEntry,
) -> NativeHandle {
    element
        .with_verified_process(
            entry.process.pid.get(),
            entry.process.process_instance.clone().unwrap_or_default(),
        )
        .into_native_handle()
}

#[cfg(target_os = "windows")]
pub(crate) fn retry_incomplete_until(
    deadline: Deadline,
    mut operation: impl FnMut() -> Result<NativeHandle, AdapterError>,
) -> Result<NativeHandle, AdapterError> {
    let mut last_incomplete: Option<AdapterError> = None;
    let mut pause = FIRST_RETRY_PAUSE;
    loop {
        if deadline.is_expired() {
            return Err(last_incomplete
                .map(mark_deadline_elapsed)
                .unwrap_or_else(|| deadline.timeout_error()));
        }
        match operation() {
            Ok(value) => return Ok(value),
            Err(error) if is_retryable_resolution_error(&error) => {
                last_incomplete = Some(error);
                sleep_before_retry(deadline, pause);
                pause = next_retry_pause(pause);
            }
            Err(error) if error.code == ErrorCode::Timeout => {
                return Err(match last_incomplete {
                    Some(incomplete) => mark_deadline_elapsed(incomplete),
                    None => error,
                });
            }
            Err(error) => return Err(error),
        }
    }
}

/// Whether the adapter's own loop should retry an error: only an explicitly
/// retryable, incomplete read. A provider's own `UIA_E_TIMEOUT` classifies
/// `Timeout` and is one of those - it is a per-call transport timeout inside
/// the operation's budget, not the budget running out. Deadline exhaustion
/// carries no retryable stamp, so it still falls through to the caller. Mirrors macOS
/// (`is_retryable_resolution_error` in `crates/macos/src/tree/resolve/mod.rs`); the granularity split between adapter-loop-settled
/// and incomplete lives in the `complete`/`retryable` details every resolver
/// error carries.
#[cfg(target_os = "windows")]
pub(crate) fn is_retryable_resolution_error(error: &AdapterError) -> bool {
    error.is_transient_incomplete_read()
}

/// Stamps the final incomplete diagnosis with `deadline_elapsed` so the
/// caller sees why the retries ran out, preserving the incomplete's own
/// details rather than discarding them for a bare `TIMEOUT`. Core owns the
/// payload (`agent_desktop_core::refs::resolve_errors::mark_deadline_elapsed`)
/// so every platform stamps the same shape.
#[cfg(target_os = "windows")]
pub(crate) use agent_desktop_core::refs::resolve_errors::mark_deadline_elapsed;

/// The non-Windows twin. The crate cross-compiles to the Linux lane with the
/// resolver reachable, but there are no UI Automation elements there, so every
/// stored ref fails closed as stale rather than attempting a search that
/// cannot find anything.
#[cfg(not(target_os = "windows"))]
pub(crate) fn resolve_element_strict(
    entry: &RefEntry,
    _deadline: Deadline,
) -> Result<NativeHandle, AdapterError> {
    Err(stale_ref_error(entry))
}

/// Reaches the stored window's root element from the ref's source window id.
///
/// The fail-closed window gate (the A7-3 wrong-target shape exists to
/// prevent): a stored ref must not search the tree of a different process that
/// has since taken over the HWND. The stored window the ref names is
/// reconstructed and put through the same stored-evidence rule
/// (`WindowIdentityEvidence::verify_stored`) the listing path uses, so the
/// live owner of the handle, not merely the liveness of the stored pid,
/// decides whether the window is still the ref's window. The macOS resolver
/// verifies its window record before searching in the same position. A
/// token-less ref (elevated process whose token could not be read) yields no
/// evidence and fails closed here rather than searching an unverified window.
///
/// The rule's own error is `WINDOW_NOT_FOUND`; the resolver reports its
/// failures as `STALE_REF`, so the verdict is adopted and the error contract
/// of this path is unchanged.
#[cfg(target_os = "windows")]
pub(crate) fn resolve_window_root(
    entry: &RefEntry,
    deadline: Deadline,
) -> Result<UIAElement, AdapterError> {
    let window_id = entry
        .source
        .source_window_id
        .as_deref()
        .ok_or_else(|| stale_ref_error(entry))?;
    let window = agent_desktop_core::WindowInfo {
        id: window_id.to_string(),
        title: entry.source.source_window_title.clone().unwrap_or_default(),
        app: entry.source.source_app.clone().unwrap_or_default(),
        pid: entry.process.pid,
        process_instance: entry.process.process_instance.clone(),
        bounds: None,
        state: Default::default(),
    };
    crate::system::window::window_identity::WindowIdentityEvidence::from_info(
        crate::system::window::window_ops::parse_handle(&window.id),
        &window,
    )
    .ok_or_else(|| stale_ref_error(entry))?
    .verify_stored()
    .map_err(|_| verify_stored_failure_error(entry, deadline))?;

    crate::tree::surfaces::surface_root(
        agent_desktop_core::ObservationRoot::Window(&window),
        entry.source.source_surface,
        deadline,
    )
}

/// Classifies a `verify_stored()` failure by the owning process's own
/// liveness, not merely the handle's: a window recreated mid-redraw by a
/// still-running process is retryable, an exited owner is terminal. Without
/// this split a dead owner's every re-attempt re-fails identically and the
/// retry loop burns the whole deadline before reporting a bare `TIMEOUT`
/// with no diagnosis. Answers only when the ref carries a real
/// process-instance token; a token-less ref keeps today's retryable
/// behaviour, since liveness cannot be checked without one.
#[cfg(target_os = "windows")]
fn verify_stored_failure_error(entry: &RefEntry, deadline: Deadline) -> AdapterError {
    let Some(instance) = entry
        .process
        .process_instance
        .as_deref()
        .filter(|instance| !instance.is_empty())
    else {
        return stale_ref_error(entry);
    };
    let identity = agent_desktop_core::ProcessIdentity::new(entry.process.pid, instance);
    match crate::system::process_state::process_state_impl(identity, deadline) {
        Ok(
            agent_desktop_core::system::process_state::ProcessState::Exited { .. }
            | agent_desktop_core::system::process_state::ProcessState::Crashed { .. },
        ) => owning_process_exited_error(entry),
        _ => stale_ref_error(entry),
    }
}

pub(crate) mod resolve_anchor;
#[cfg(target_os = "windows")]
pub(crate) mod resolve_chrome_repair;
pub(crate) mod resolve_match;
pub(crate) mod resolve_pacing;
pub(crate) mod resolve_search;
#[cfg(all(test, target_os = "windows"))]
#[path = "resolve_tests.rs"]
mod windows_only;

#[cfg(all(test, target_os = "windows"))]
#[path = "resolve_pair_window.rs"]
mod pair_window;
