//! The shared single-element live read and its five projections.
//!
//! Mirrors macOS `post_state.rs`'s single shared read: one function takes a
//! resolved `NativeHandle`, corroborates the verified process identity the
//! resolver stamped into the handle payload - a dead provider never
//! satisfies completeness, because a corpse's reads can succeed empty on some
//! builds (A14-9), reads the full walk property set live through
//! `properties::read_live`, and projects it through the walk's own vocabulary
//! composition (`read_label` + `walk_vocabulary` + `locator_evidence`).
//! The five readers are projections over that one read: value, state, actions,
//! element, bounds.
//!
//! The process corroboration runs twice, not once: a first, cheap check
//! before the read rejects an already-dead handle without paying for a
//! property fetch, and a second, authoritative check after the read and its
//! completeness gate rejects a handle whose process died *during* the read -
//! the corpse case A14-9 measured, where the dead provider's reads still
//! return success. Only the second check's answer is trusted to gate the
//! `Ok`; the first is an optimization, not a substitute. Separately, the
//! read's own discarded errors are inspected for the vanished-element
//! disposition before the completeness gate ever sees them, so a resolved
//! target that reports `UIA_E_ELEMENTNOTAVAILABLE` settles as stale rather
//! than surfacing as a retryable, indefinitely-repeated `AppUnresponsive`.

use agent_desktop_core::adapter::live_element::{
    essential_live_evidence_complete, incomplete_live_evidence, known_actions,
};
use agent_desktop_core::{
    AdapterError, ElementState, ErrorCode, LiveElement, LiveIdentity, LocatorEvidence, Rect,
    tree::roles,
};

use super::properties::element_properties::ElementProperties;

/// One element's live read: the properties set kept alongside the projected
/// evidence, because `ElementState.enabled`/`offscreen` read `IsEnabled`/
/// `IsOffscreen` from the property set and `locator_evidence` does not
/// carry them.
pub(crate) struct LiveRead {
    pub(crate) properties: ElementProperties,
    pub(crate) evidence: LocatorEvidence,
}

#[cfg(target_os = "windows")]
mod imp {
    use super::{
        LiveRead, essential_live_evidence_complete, incomplete_live_evidence, stale_reader_error,
        target_read_reports_vanished,
    };
    use crate::tree::element::{UIAElement, uia_element};
    use crate::tree::name_evidence::{LabelOutcome, read_label};
    use crate::tree::properties::{ElementProperties, read_live_bounded};
    use crate::tree::walk::walker::walk_vocabulary;
    use agent_desktop_core::{AdapterError, Deadline, NativeHandle, ProcessId};

    /// The shared single-element live read.
    ///
    /// Fails `STALE_REF`-class when the verified process token has moved on
    /// either before or after the read (the dead-provider shape, driven
    /// through a dead token), fails `STALE_REF`-class when the read itself
    /// reports the resolved target vanished, and fails retryable
    /// `AppUnresponsive` when an essential slot reads `Unknown` - it never
    /// answers with a partial bundle claiming completeness.
    ///
    /// Wires `properties::read_live_bounded` rather than the unbounded
    /// `read_live`: the property set is 43 properties wide, one cross-process
    /// call apiece, and nothing checked the operation deadline between them -
    /// a poll-style caller (`resolve.rs`'s retry loop, core's ref-action poll)
    /// could overshoot its own user-visible timeout on every single iteration.
    /// `read_live_bounded` consults the same deadline between property reads
    /// and truncates the set rather than running past it; a truncated read
    /// still reaches the completeness gate below, which is the established
    /// incomplete/retryable shape for "did not finish in time" - no new
    /// timing abstraction, no change to what a successful read returns.
    pub fn read_live_element(
        handle: &NativeHandle,
        deadline: Deadline,
    ) -> Result<LiveRead, AdapterError> {
        let element = uia_element(handle)?;
        let outside_visible_area =
            crate::tree::minimized::owning_window_minimized(element, deadline).unwrap_or(false)
                || crate::tree::minimized::outside_scroll_viewports(element, deadline)?;
        read_live_element_core(
            element,
            deadline,
            outside_visible_area,
            corroborate_verified_process,
            |element| read_live_bounded(element, deadline),
            |element| read_label(element, false),
        )
    }

    /// The read's body, generic over how process-instance corroboration and
    /// the property read itself are performed.
    ///
    /// Production always passes the real corroborator, the real bounded
    /// property read and the real label read; a test substitutes one of them
    /// to drive a specific failure deterministically - a fake corroborator
    /// that answers live once and dead the next call stands in for a process
    /// that dies between the pre-read and post-read checks (A14-9's corpse
    /// timing, which a real process kill cannot reproduce without a race), a
    /// fake read stands in for a resolved target that has vanished or for one
    /// whose essential slots could not be read at all, and a counting label
    /// read proves the deadline actually suppresses it.
    ///
    /// The label read is skipped outright once the deadline has passed. It
    /// costs one to three further cross-process calls, and by the time it is
    /// reached the bounded property read has already stopped issuing its own
    /// for exactly that reason; spending more after the budget is gone is the
    /// overshoot the bounded read exists to prevent. A skipped label settles
    /// `LabelOutcome::Failed`, the outcome for a label that could not be
    /// read, and never `Unlabelled`, which would claim the provider publishes
    /// no label relation - a claim nothing measured. No slot the completeness
    /// gate inspects is derived from the label, so skipping it cannot change
    /// the verdict; it only leaves the name slot uncertain, which is the
    /// honest report for work that was never done.
    pub(crate) fn read_live_element_core(
        element: &UIAElement,
        deadline: Deadline,
        owning_window_minimized: bool,
        corroborate: impl Fn(&UIAElement) -> Result<(), AdapterError>,
        read: impl Fn(&UIAElement) -> (ElementProperties, Vec<AdapterError>),
        read_label: impl Fn(&UIAElement) -> LabelOutcome,
    ) -> Result<LiveRead, AdapterError> {
        deadline.ensure_remaining()?;
        corroborate(element)?;
        if deadline.is_expired() {
            return Err(deadline.timeout_error());
        }
        let (mut properties, errors) = read(element);
        if target_read_reports_vanished(&errors) {
            return Err(stale_reader_error());
        }
        if owning_window_minimized {
            crate::tree::minimized::stamp_minimized_offscreen(&mut properties);
        }
        let label = if deadline.is_expired() {
            LabelOutcome::Failed
        } else {
            read_label(element)
        };
        let vocabulary = walk_vocabulary(&properties, &label);
        let evidence = properties.locator_evidence(vocabulary);
        if !essential_live_evidence_complete(&evidence) {
            return Err(incomplete_live_evidence());
        }
        corroborate(element)?;
        Ok(LiveRead {
            properties,
            evidence,
        })
    }

    /// Corroborates the handle's verified process token against the
    /// process's live generation, right now.
    ///
    /// Not memoized: called again after the read, it genuinely re-queries the
    /// OS rather than trusting the answer the pre-read call already gave,
    /// which is what lets the post-read call catch a process that died
    /// during the read.
    pub(crate) fn corroborate_verified_process(element: &UIAElement) -> Result<(), AdapterError> {
        if let Some((pid, token)) = element.verified_process() {
            if !crate::system::process_identity::matches_instance(ProcessId::new(pid), token)? {
                return Err(stale_reader_error());
            }
        }
        Ok(())
    }
}

#[cfg(not(target_os = "windows"))]
mod imp {
    use super::LiveRead;
    use agent_desktop_core::{AdapterError, Deadline, NativeHandle};

    /// Canned twin so the adapter compiles on a non-Windows lane; there are no
    /// live elements there, so every live read is refused rather than faked.
    pub fn read_live_element(
        _handle: &NativeHandle,
        _deadline: Deadline,
    ) -> Result<LiveRead, AdapterError> {
        Err(AdapterError::not_supported("get_live_*"))
    }
}

#[cfg(target_os = "windows")]
pub(crate) use imp::{corroborate_verified_process, read_live_element};

#[cfg(not(target_os = "windows"))]
pub(crate) use imp::read_live_element;

/// The value projection: a secure field's stored value is `Absent` here by
/// the shared read's own withholding, so nothing secure escapes.
pub(crate) fn live_value(read: &LiveRead) -> Option<String> {
    read.evidence.value.known().cloned()
}

/// The state projection.
///
/// Provider flags include the shared read's minimized-window and viewport
/// clipping corrections. `hidden` stays unset because UIA has no separate flag.
pub(crate) fn live_state(read: &LiveRead) -> Result<ElementState, AdapterError> {
    let role = read
        .evidence
        .role
        .known()
        .cloned()
        .ok_or_else(incomplete_live_evidence)?;
    let states = read.evidence.states.known().cloned().unwrap_or_default();
    let value = live_value(read);
    let enabled = read
        .properties
        .get(super::properties::property_ids::TreeProperty::IsEnabled)
        .flag();
    let offscreen = read
        .properties
        .get(super::properties::property_ids::TreeProperty::IsOffscreen)
        .flag();
    Ok(ElementState {
        role,
        states,
        value,
        enabled,
        hidden: None,
        offscreen,
    })
}

/// The actions projection (a free projection, no pattern invocation).
pub(crate) fn live_actions(read: &LiveRead) -> Result<Vec<String>, AdapterError> {
    known_actions(read.evidence.ref_evidence.available_actions.clone())
}

/// The element projection: identity, state, bounds and actions all off the
/// one shared read.
pub(crate) fn live_element(read: &LiveRead) -> Result<LiveElement, AdapterError> {
    let state = live_state(read)?;
    let identity = LiveIdentity {
        name: read.evidence.name.clone(),
        description: read.evidence.description.clone(),
        identifiers: read.evidence.identifiers.clone(),
    };
    let available_actions = live_actions(read)?;
    let bounds = read.evidence.ref_evidence.bounds.known().copied();
    let states_complete = states_are_complete(read, &state.role);
    Ok(LiveElement {
        identity,
        state,
        states_complete,
        bounds,
        available_actions,
    })
}

/// Whether the control-state evidence the post-action verifier reads was
/// actually observed: a toggleable role needs a readable `ToggleState`, and
/// the expand half needs a readable `ExpandCollapseState` wherever it applies.
/// It applies to any element that advertises the pattern, and to an
/// expandable role unless the provider answered that it has no
/// `ExpandCollapse` pattern (a WinForms drop-down list on build 17763 has
/// none, and demanding its state refused every action on it). A failed
/// availability read on a non-expandable role leaves the half unapplied:
/// counting it as unobserved would hold the visibility gate at unknown for an
/// ordinary button whenever one optional read fails. A gate that never opened
/// yields no value, and a defaulted value is not an observation.
fn states_are_complete(read: &LiveRead, role: &str) -> bool {
    use super::properties::property_outcome::PropertyOutcome;
    let toggle_observed = !roles::is_toggleable_role(role)
        || read
            .properties
            .gated_number(super::properties::property_ids::TreeProperty::ToggleState)
            .is_some();
    let available = super::properties::property_ids::TreeProperty::ExpandCollapseAvailable;
    let advertised = read.properties.is_true(available);
    let expand_applies = match read.properties.get(available) {
        PropertyOutcome::Known(_) => advertised,
        PropertyOutcome::Unknown | PropertyOutcome::Absent => roles::is_expandable_role(role),
    };
    let expand_observed = !expand_applies
        || read
            .properties
            .gated_number(super::properties::property_ids::TreeProperty::ExpandCollapseState)
            .is_some();
    toggle_observed && expand_observed
}

/// The bounds projection, with the same essential-completeness discipline as
/// the other readers: an unknown bounds read fails the shared read first.
pub(crate) fn live_bounds(read: &LiveRead) -> Option<Rect> {
    read.evidence.ref_evidence.bounds.known().copied()
}

/// Reports whether the read's own discarded errors already settled the
/// resolved target as vanished.
///
/// Keyed on `error.code` alone, deliberately not on a code-plus-retryable-flag
/// coincidence. Every entry in the vector this function inspects comes from
/// `properties::read_live_bounded`, and that vector can only ever be built
/// two ways: a property-read failure, always classified through
/// `uia_failure_error` - which decides the code through
/// `hresult::hresult_record` (HRESULT branch) or `automation_classify.rs`'s
/// `sentinel_record` (sentinel branch), the only two places `StaleRef` can
/// enter this vector, each naming it for exactly one family
/// (`UIA_E_ELEMENTNOTAVAILABLE`, `ERR_INVALID_OBJECT`), both
/// `ReadDisposition::Unavailable` and exhaustively pinned by
/// `hresult_tests.rs` and `automation_classify.rs`'s own test module - or the
/// deadline's own `timeout_error()` push on truncation, which is always
/// `ErrorCode::Timeout` and never reaches `uia_failure_error` at all. Neither
/// path can produce a `StaleRef` that means anything else, so a `StaleRef`
/// code here is unambiguous. (The rest of this crate also constructs
/// `ErrorCode::StaleRef` directly - `resolve_match.rs`'s `stale_ref_error`,
/// this module's own `stale_reader_error`, `surfaces.rs` - but none of those
/// errors can reach this vector, since it only ever collects property-read
/// failures and the deadline's truncation stamp.) The check also does not
/// need to lean on whether a later `.with_details` call (as
/// `properties::property_read_error` makes) preserves a typed retryable
/// flag: `AdapterError::with_details` only touches `retryability` when the
/// new details carry their own `retryable` key, so a wrap that omits one -
/// `property_read_error`'s does - leaves whatever stamp was already there
/// unchanged, never loses it.
fn target_read_reports_vanished(errors: &[AdapterError]) -> bool {
    errors.iter().any(|error| error.code == ErrorCode::StaleRef)
}

/// The vanished-target answer, built through core's shared
/// `AdapterError::stale_ref_because` constructor so the two sites cannot
/// drift into two different payloads for the same class of failure. It
/// carries no `retryable` key on purpose: `with_details` only overwrites the
/// typed retryability when the details name it, so this error keeps the
/// code's default rather than claiming a verdict it has not earned.
fn stale_reader_error() -> AdapterError {
    AdapterError::stale_ref_because("Element became invalid while reading live state").with_details(
        serde_json::json!({
            "kind": "live_element_invalid",
            "complete": true,
        }),
    )
}

#[cfg(all(test, target_os = "windows"))]
#[path = "live_read_tests.rs"]
mod tests;

/// Split from `live_read_tests.rs` to keep both files under the crate's
/// per-file line cap: this module owns the one test that mutates the
/// fixture's content control cross-process, plus the Win32 lookup helpers
/// that only that test needs.
#[cfg(all(test, target_os = "windows"))]
#[path = "live_read_edit_tests.rs"]
mod edit_tests;

/// Split from `live_read_tests.rs` for the same reason: this module owns the
/// tests that drive the shared read through the closures it is generic over,
/// standing in for failures a real fixture cannot be made to produce on
/// demand.
#[cfg(all(test, target_os = "windows"))]
#[path = "live_read_seam_tests.rs"]
mod seam_tests;

/// Split out because the completeness gate is a pure predicate over evidence:
/// its tests need no UI Automation client and run on every target, which the
/// fixture-driven modules above cannot.
#[cfg(test)]
#[path = "live_read_gate_tests.rs"]
mod gate_tests;

/// Split from `live_read_tests.rs` for the per-file line cap: the
/// states-completeness predicate's truth table is likewise a pure function of
/// the read set and the resolved role, so it needs no UI Automation client and
/// runs on every target.
#[cfg(test)]
#[path = "live_read_states_complete_tests.rs"]
mod states_complete_tests;
