use super::*;
use crate::wait::deadline::VirtualClock;
use std::time::Duration;

#[test]
fn normalized_typed_text_is_reported_as_delivered_unverified() {
    for (before, requested, normalized, selection) in [
        ("", "(7+8)*9", "(7+8)×9", None),
        ("", "200*10%", "200×10%", None),
        ("×", "*", "×", Some(0..1)),
    ] {
        let mut adapter = adapter(
            element(Some(before), &["focused"]),
            element(Some(normalized), &[]),
        );
        adapter.selection = selection;
        adapter.execution = Ok(ActionResult::delivered_unverified("type").with_steps(vec![
            ActionStep::succeeded("XTEST.type_text")
                .with_mechanism(crate::StepMechanism::PhysicalSynthetic)
                .with_verified(false),
        ]));
        let result = execute_verified_action(
            &adapter,
            &NativeHandle::null(),
            ActionRequest::headed(Action::TypeText(requested.into())),
            &InteractionLease::guarded(Deadline::after(1000).unwrap(), ()).unwrap(),
        )
        .unwrap();
        assert_eq!(
            result.disposition(),
            DeliverySemantics::delivered_unverified()
        );
        assert_eq!(
            result.details.as_ref().unwrap()["verification_reason"],
            "postcondition_mismatch"
        );
        assert_eq!(
            result.post_state.unwrap().value.as_deref(),
            Some(normalized)
        );
        assert_eq!(adapter.calls.load(Ordering::SeqCst), 1);
    }
}

const TYPED: &str = "the quick brown fox jumps over the lazy dog";
const READS_BEFORE_SETTLING: usize = 2;

fn typed_by_keys_adapter(after: &str) -> Adapter {
    let mut adapter = adapter(element(Some(""), &["focused"]), element(Some(after), &[]));
    adapter.execution = Ok(ActionResult::delivered_unverified("type").with_steps(vec![
        ActionStep::succeeded("XTEST.type_text")
            .with_mechanism(crate::StepMechanism::PhysicalSynthetic)
            .with_verified(false),
    ]));
    adapter
}

fn filling(prefixes: usize) -> std::collections::VecDeque<LiveElement> {
    (1..=prefixes)
        .map(|len| element(Some(&TYPED[..len.min(TYPED.len())]), &[]))
        .collect()
}

fn type_keys(adapter: &Adapter, budget_ms: u64) -> ActionResult {
    execute_verified_action(
        adapter,
        &NativeHandle::null(),
        ActionRequest::headed(Action::TypeText(TYPED.into())),
        &InteractionLease::guarded(Deadline::after(budget_ms).unwrap(), ()).unwrap(),
    )
    .unwrap()
}

#[test]
fn keys_still_filling_the_field_after_the_settle_window_are_read_until_the_text_is_there() {
    let clock = VirtualClock::freeze();
    let adapter = typed_by_keys_adapter(TYPED);
    *adapter.settling.lock().unwrap() = filling(12);

    let result = type_keys(&adapter, 5_000);

    assert_eq!(
        result.disposition(),
        DeliverySemantics::delivered_verified()
    );
    assert_eq!(result.post_state.unwrap().value.as_deref(), Some(TYPED));
    assert_eq!(
        adapter.reads.lock().unwrap().len(),
        READS_BEFORE_SETTLING + 12
    );
    assert_eq!(clock.elapsed(), Duration::from_millis(12 * 50));
}

#[test]
fn keys_that_keep_changing_the_field_past_the_budget_stay_unverified() {
    let clock = VirtualClock::freeze();
    let adapter = typed_by_keys_adapter(&TYPED[..1]);
    *adapter.settling.lock().unwrap() = filling(TYPED.len() - 1);

    let result = type_keys(&adapter, 700);

    assert_eq!(
        result.disposition(),
        DeliverySemantics::delivered_unverified()
    );
    assert_eq!(
        result.details.unwrap()["verification_reason"],
        "postcondition_mismatch"
    );
    assert!(clock.elapsed() <= Duration::from_millis(700));
}

#[test]
fn keys_that_left_the_field_unchanged_are_not_waited_for_until_the_budget_ends() {
    let clock = VirtualClock::freeze();
    let adapter = typed_by_keys_adapter(&TYPED[..3]);

    let result = type_keys(&adapter, 5_000);

    assert_eq!(
        result.disposition(),
        DeliverySemantics::delivered_unverified()
    );
    assert!(adapter.reads.lock().unwrap().len() <= 12);
    assert!(clock.elapsed() <= Duration::from_millis(400));
}
