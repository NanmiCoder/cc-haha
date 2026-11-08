//! The seam-driven half of the shared live read's tests.
//!
//! Every case here drives `read_live_element_core` through one of the
//! closures it is generic over - the corroborator, the property read, the
//! label read - because each stands in for a condition a real fixture cannot
//! be made to produce on demand: a process that dies mid-read, a resolved
//! element that vanishes while its process stays alive, a read that comes
//! back with nothing in it, a budget that runs out between the property read
//! and the label read. The projections over an ordinary successful read stay
//! in `live_read_tests.rs`, and the completeness predicate's own truth table
//! in `live_read_gate_tests.rs`.

use super::imp::{corroborate_verified_process, read_live_element_core};
use super::tests::{live_label, verified_handle};
use crate::system::runtime::hresult::UIA_E_ELEMENTNOTAVAILABLE;
use crate::tree::automation::{UiaFailure, uia_failure_error};
use crate::tree::element::UIAElement;
use crate::tree::fixture::{HostedFixture, ensure_test_apartment};
use crate::tree::properties::property_ids::TreeProperty;
use crate::tree::properties::{ElementProperties, read_live};
use crate::tree::walk::walker_fake::deadline;
use agent_desktop_core::{AdapterError, Deadline, ErrorCode};
use std::cell::Cell;
use std::time::Duration;

/// Short enough that the label-skip test does not sit idle, long enough that
/// the entry check cannot see it expire before the read is even attempted.
const SPENT_BUDGET_MS: u64 = 300;

/// How far past the budget the fake read sleeps, so the deadline is decidedly
/// gone by the time the label read would be issued rather than borderline.
const BUDGET_OVERRUN: Duration = Duration::from_millis(50);

fn details_flag(error: &AdapterError, key: &str) -> Option<bool> {
    error
        .details
        .as_ref()
        .and_then(|details| details.get(key))
        .and_then(serde_json::Value::as_bool)
}

/// A regression pin for the corpse race A14-9 measured: a token that reads
/// live at the pre-read check must not be trusted for the rest of the call.
/// Driven through the fake-corroborator injection seam on
/// `read_live_element_core` rather than a real process kill, because timing a
/// real kill against the read without a race is not possible - the fake
/// answers live on the pre-read call and dead on every call after, the
/// deterministic stand-in for a process that dies during the read. Removing
/// the post-read corroboration call `read_live_element_core` makes would turn
/// this `Err` into an `Ok` built from a real, successfully-read fixture
/// element.
#[test]
fn a_process_that_dies_during_the_read_settles_stale_not_ok() {
    ensure_test_apartment();
    let fixture = HostedFixture::spawn().expect("a fixture host starts");
    let handle = verified_handle(&fixture).expect("a verified handle");
    let element = handle
        .downcast_ref::<UIAElement>()
        .expect("a UIAElement payload");
    let calls = Cell::new(0u32);
    let corroborate = |_: &UIAElement| {
        let already_called = calls.get();
        calls.set(already_called + 1);
        if already_called == 0 {
            Ok(())
        } else {
            Err(super::stale_reader_error())
        }
    };

    let error = match read_live_element_core(
        element,
        deadline(),
        false,
        corroborate,
        read_live,
        live_label,
    ) {
        Err(error) => error,
        Ok(_) => panic!("a token that goes dead mid-call must not read Ok"),
    };
    assert_eq!(error.code, ErrorCode::StaleRef);
    assert_eq!(
        calls.get(),
        2,
        "both the pre-read and the post-read corroboration call must run"
    );
}

/// The vanished-but-live-process shape Finding B measured: the owning process
/// answers corroboration honestly, and only the specific resolved element is
/// gone. A read whose own errors already carry the
/// `UIA_E_ELEMENTNOTAVAILABLE` disposition - built through the same
/// `uia_failure_error` classifier a real UI Automation failure would go
/// through - must settle a complete `STALE_REF`, never fall through to the
/// completeness gate's retryable `AppUnresponsive`.
#[test]
fn a_vanished_resolved_target_settles_stale_not_retryable_unresponsive() {
    ensure_test_apartment();
    let fixture = HostedFixture::spawn().expect("a fixture host starts");
    let handle = verified_handle(&fixture).expect("a verified handle");
    let element = handle
        .downcast_ref::<UIAElement>()
        .expect("a UIAElement payload");
    let vanished_read = |_: &UIAElement| {
        let error = uia_failure_error(
            UiaFailure::Hresult(UIA_E_ELEMENTNOTAVAILABLE),
            "read an element property",
        );
        (ElementProperties::from_reads(Vec::new()), vec![error])
    };

    let error = match read_live_element_core(
        element,
        deadline(),
        false,
        corroborate_verified_process,
        vanished_read,
        live_label,
    ) {
        Err(error) => error,
        Ok(_) => panic!("a vanished resolved target must not read as complete"),
    };
    assert_eq!(error.code, ErrorCode::StaleRef);
    assert_eq!(
        details_flag(&error, "complete"),
        Some(true),
        "a vanished target settles complete, it is never retried"
    );
}

/// The same vanished-target shape, but wrapped through the real
/// `property_read_error` - the wrapper `properties::read_live_bounded`
/// actually applies to every error it collects - rather than through
/// `uia_failure_error` alone. `property_read_error` calls `.with_details`
/// with a payload that carries no `retryable` key, which fully replaces the
/// error's details JSON but cannot touch `error.code` at all: `with_details`
/// only ever writes `code`-independent fields. This test exercises that real
/// wrapper end to end - the one every property-read failure actually passes
/// through - rather than only the raw classifier the test above calls
/// directly, confirming `target_read_reports_vanished`'s `error.code` check
/// still sees `StaleRef` once the production wrap has run.
#[test]
fn a_vanished_target_wrapped_through_the_real_property_read_error_still_settles_stale() {
    ensure_test_apartment();
    let fixture = HostedFixture::spawn().expect("a fixture host starts");
    let handle = verified_handle(&fixture).expect("a verified handle");
    let element = handle
        .downcast_ref::<UIAElement>()
        .expect("a UIAElement payload");
    let vanished_read = |_: &UIAElement| {
        let base = uia_failure_error(
            UiaFailure::Hresult(UIA_E_ELEMENTNOTAVAILABLE),
            "read an element property",
        );
        let wrapped = crate::tree::properties::property_read_error(
            base,
            crate::tree::properties::property_ids::TreeProperty::Value,
        );
        (ElementProperties::from_reads(Vec::new()), vec![wrapped])
    };

    let error = match read_live_element_core(
        element,
        deadline(),
        false,
        corroborate_verified_process,
        vanished_read,
        live_label,
    ) {
        Err(error) => error,
        Ok(_) => panic!(
            "a vanished target wrapped through property_read_error must not read as complete"
        ),
    };
    assert_eq!(error.code, ErrorCode::StaleRef);
}

/// The completeness gate's *wiring*, which no other test can see: a read
/// whose essential slots could not be filled must fail retryable rather than
/// answer a partial bundle that claims completeness.
///
/// Driven through the fake read seam with a bundle carrying no property
/// outcomes at all - so every essential slot reads `Unknown` - and no errors,
/// so nothing earlier in the body can settle the call and the gate is the
/// only thing left that can. The process is genuinely alive and the real
/// corroborator agrees, which is what makes the `Ok` this rejects reachable:
/// remove the gate and this call returns a `LiveRead` whose evidence knows
/// nothing about the element. `live_read_gate_tests.rs` pins the predicate
/// and the error it raises, and stays green either way.
#[test]
fn a_bundle_whose_essential_slots_are_unknown_fails_retryable_never_partial() {
    ensure_test_apartment();
    let fixture = HostedFixture::spawn().expect("a fixture host starts");
    let handle = verified_handle(&fixture).expect("a verified handle");
    let element = handle
        .downcast_ref::<UIAElement>()
        .expect("a UIAElement payload");
    let unread = |_: &UIAElement| (ElementProperties::from_reads(Vec::new()), Vec::new());

    let error = match read_live_element_core(
        element,
        deadline(),
        false,
        corroborate_verified_process,
        unread,
        live_label,
    ) {
        Err(error) => error,
        Ok(_) => panic!("a bundle with no essential slot read must not answer as a live read"),
    };
    assert_eq!(error.code, ErrorCode::AppUnresponsive);
    assert!(
        error.is_explicitly_retryable(),
        "an incomplete read is worth retrying, unlike a vanished target"
    );
    assert_eq!(
        details_flag(&error, "complete"),
        Some(false),
        "a partial read must never claim completeness"
    );
    assert_eq!(details_flag(&error, "retryable"), Some(true));
}

/// The label read costs one to three further cross-process calls, and it used
/// to be issued unconditionally - including after the bounded property read
/// had already stopped issuing its own because the deadline was gone, which
/// is the overshoot the bounded read exists to prevent.
///
/// Both directions run off the same element, so the only difference between
/// them is the budget: with budget left the label is read exactly once, and
/// with the budget spent inside the read itself it is not read at all, while
/// the call still answers the same way. The fake read sleeps the remaining
/// budget out rather than the test handing in an already-expired deadline,
/// because an expired deadline is refused before the read is ever attempted
/// and the label read would never be reached.
#[test]
fn a_spent_deadline_skips_the_label_read_without_changing_the_outcome() {
    ensure_test_apartment();
    let fixture = HostedFixture::spawn().expect("a fixture host starts");
    let handle = verified_handle(&fixture).expect("a verified handle");
    let element = handle
        .downcast_ref::<UIAElement>()
        .expect("a UIAElement payload");
    let unhurried_labels = Cell::new(0u32);
    let spent_labels = Cell::new(0u32);
    let counted = |calls: &Cell<u32>, element: &UIAElement| {
        calls.set(calls.get() + 1);
        live_label(element)
    };

    let unhurried = read_live_element_core(
        element,
        deadline(),
        false,
        corroborate_verified_process,
        read_live,
        |element| counted(&unhurried_labels, element),
    )
    .expect("a read with budget left succeeds");

    let spent_budget = Deadline::after(SPENT_BUDGET_MS).expect("a short deadline builds");
    let read_past_the_budget = |element: &UIAElement| {
        std::thread::sleep(spent_budget.remaining() + BUDGET_OVERRUN);
        read_live(element)
    };
    let spent = read_live_element_core(
        element,
        spent_budget,
        false,
        corroborate_verified_process,
        read_past_the_budget,
        |element| counted(&spent_labels, element),
    )
    .expect("a read whose budget ran out mid-read still answers");

    assert_eq!(
        unhurried_labels.get(),
        1,
        "a read with budget left reads the label once"
    );
    assert_eq!(
        spent_labels.get(),
        0,
        "a read whose deadline is gone must not issue the label's further cross-process calls"
    );
    assert_eq!(
        spent.evidence.role, unhurried.evidence.role,
        "skipping the label must not change what the read concludes"
    );
}

/// A minimized owner reports its subtree offscreen even though the provider
/// keeps clearing `IsOffscreen` on the descendants (the A14-8 divergence):
/// the stamp overwrites the flag, the projected state, and the state token
/// together, which is what flips both `is visible` and the preflight
/// visibility gate.
#[test]
fn a_minimized_owner_reports_its_subtree_offscreen_in_the_live_read() {
    ensure_test_apartment();
    let fixture = HostedFixture::spawn().expect("a fixture host starts");
    let handle = verified_handle(&fixture).expect("a verified handle");
    let element = handle
        .downcast_ref::<UIAElement>()
        .expect("a UIAElement payload");

    let read = read_live_element_core(
        element,
        deadline(),
        true,
        corroborate_verified_process,
        read_live,
        live_label,
    )
    .expect("a live read succeeds");

    assert_eq!(
        read.properties.get(TreeProperty::IsOffscreen).flag(),
        Some(true)
    );
    let state = super::live_state(&read).expect("the state projects");
    assert_eq!(state.offscreen, Some(true));
    assert!(
        state.states.iter().any(|state| state == "offscreen"),
        "the state token must travel with the flag"
    );
}

/// A restored owner leaves the provider's own `IsOffscreen` answer alone.
#[test]
fn a_restored_owner_keeps_the_provider_offscreen_answer() {
    ensure_test_apartment();
    let fixture = HostedFixture::spawn().expect("a fixture host starts");
    let handle = verified_handle(&fixture).expect("a verified handle");
    let element = handle
        .downcast_ref::<UIAElement>()
        .expect("a UIAElement payload");
    let (raw, _) = read_live(element);

    let read = read_live_element_core(
        element,
        deadline(),
        false,
        corroborate_verified_process,
        read_live,
        live_label,
    )
    .expect("a live read succeeds");

    assert_eq!(
        read.properties.get(TreeProperty::IsOffscreen).flag(),
        raw.get(TreeProperty::IsOffscreen).flag()
    );
}
