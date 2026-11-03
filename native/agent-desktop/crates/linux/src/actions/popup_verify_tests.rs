use std::cell::Cell;

use super::*;
use agent_desktop_core::DeliveryDisposition;

#[test]
fn qt_popup_backend_discovery_failure_is_not_a_native_platform_limitation() {
    use crate::system::x11::window::window_kind::WindowKind;

    require_qt_popup_backend(
        true,
        ControlRead::Ready(vec![Toplevel {
            id: 1,
            title: String::new(),
            kind: WindowKind::Normal,
            transient: false,
        }]),
    )
    .expect("a proven XWayland window permits semantic opening");

    for (configured, windows, native) in [
        (true, ControlRead::Ready(vec![]), true),
        (false, ControlRead::NotX11, true),
        (true, ControlRead::NotX11, false),
        (true, ControlRead::NoManager, false),
        (true, ControlRead::Unavailable, false),
    ] {
        let error = require_qt_popup_backend(configured, windows).expect_err("refuse opening");
        assert_eq!(error.disposition, DeliverySemantics::not_delivered());
        assert_eq!(
            error.code,
            if native {
                ErrorCode::ActionNotSupported
            } else {
                ErrorCode::ActionFailed
            }
        );
        assert_eq!(
            error.details.expect("backend evidence")["kind"],
            if native {
                "native_popup_requires_input"
            } else {
                "popup_backend_unproven"
            }
        );
    }
}

#[test]
fn menu_regression_pressed_opener_without_a_popup_never_verifies_delivery() {
    let popup = AtspiElement::new(":1.1", "/popup", 7);
    for (wanted, before, after, verified, overview_reads) in [
        (None, vec![], Some(vec![]), false, 1),
        (Some(true), vec![], Some(vec![]), false, 1),
        (Some(true), vec![], None, false, 0),
        (
            Some(false),
            vec![popup.clone()],
            Some(vec![popup.clone()]),
            false,
            0,
        ),
        (None, vec![], Some(vec![popup.clone()]), true, 0),
        (Some(true), vec![], Some(vec![popup.clone()]), true, 0),
        (Some(false), vec![popup], Some(vec![]), true, 0),
    ] {
        let result = ActionResult::delivered_unverified("click")
            .with_steps(vec![
                agent_desktop_core::ActionStep::succeeded("Action.DoAction").with_verified(true),
            ])
            .with_verified_delivery();
        let events = std::cell::RefCell::new(Vec::new());
        let reads = Cell::new(0);
        let actual = attempt(
            wanted,
            || {
                events.borrow_mut().push("before");
                Some(before)
            },
            || {
                events.borrow_mut().push("invoke");
                Ok(result)
            },
            |_| {
                events.borrow_mut().push("after");
                after
            },
            || {
                reads.set(reads.get() + 1);
                Some(false)
            },
        );
        assert_eq!(*events.borrow(), ["before", "invoke", "after"]);
        assert_eq!(
            reads.get(),
            overview_reads,
            "the Overview is read once for a popup that never appeared and for nothing else"
        );
        if verified {
            assert_eq!(
                actual.expect("popup observed").disposition().delivery(),
                DeliveryDisposition::DeliveredVerified
            );
        } else {
            let error = actual.expect_err("state alone must not verify");
            assert_eq!(error.disposition, DeliverySemantics::delivered_unverified());
            let details = error.details.expect("evidence");
            assert_eq!(details["kind"], "popup_not_observed");
            assert_eq!(details["steps"][0]["verified"], false);
        }
    }
}

#[test]
fn an_unobserved_popup_after_a_noop_preserves_no_delivery() {
    let result = ActionResult::satisfied_without_delivery("expand");
    let error = confirm(result, Some(true), &[], Some(&[]), || None).expect_err("no popup");
    assert_eq!(error.disposition, DeliverySemantics::not_delivered());
}

#[test]
fn an_unread_baseline_refuses_before_invoking_the_opener() {
    let error = attempt(
        Some(true),
        || None,
        || panic!("an unread baseline must not deliver"),
        |_| panic!("there was no action to verify"),
        || panic!("a refusal before delivery has no popup to explain"),
    )
    .expect_err("refusal");
    assert_eq!(error.disposition, DeliverySemantics::not_delivered());
}

#[test]
fn expanding_an_open_popup_is_an_honest_no_op_and_not_an_error() {
    let popup = AtspiElement::new(":1.1", "/popup", 7);
    let result = attempt(
        Some(true),
        || Some(vec![popup.clone()]),
        || Ok(ActionResult::satisfied_without_delivery("expand")),
        |before| Some(before.to_vec()),
        || panic!("a popup that is open needs no explanation"),
    )
    .expect("an open popup is the wanted state");
    assert_eq!(
        result.disposition().delivery(),
        DeliveryDisposition::NotDelivered
    );
}

fn failed_open(
    result: ActionResult,
    wanted: Option<bool>,
    before: &[AtspiElement],
    after: Option<&[AtspiElement]>,
    overview: Option<bool>,
) -> (AdapterError, usize) {
    let reads = Cell::new(0);
    let error = confirm(result, wanted, before, after, || {
        reads.set(reads.get() + 1);
        overview
    })
    .expect_err("the popup was not observed");
    (error, reads.get())
}

fn unverified(action: &str) -> ActionResult {
    ActionResult::delivered_unverified(action).with_steps(vec![
        agent_desktop_core::ActionStep::succeeded("Action.DoAction"),
    ])
}

#[test]
fn an_open_overview_is_named_as_the_cause_of_a_popup_that_never_appeared() {
    for (wanted, result, disposition) in [
        (
            None,
            unverified("click"),
            DeliverySemantics::delivered_unverified(),
        ),
        (
            Some(true),
            unverified("expand"),
            DeliverySemantics::delivered_unverified(),
        ),
        (
            Some(true),
            ActionResult::satisfied_without_delivery("expand"),
            DeliverySemantics::not_delivered(),
        ),
    ] {
        let (error, reads) = failed_open(result, wanted, &[], Some(&[]), Some(true));
        assert_eq!(reads, 1);
        assert_eq!(error.code, ErrorCode::ActionFailed);
        assert_eq!(error.disposition, disposition);
        assert_eq!(
            error.suggestion.as_deref(),
            Some(Cause::OverviewOpen.suggestion())
        );
        let details = error.details.expect("evidence");
        assert_eq!(details["kind"], "popup_not_observed");
        assert_eq!(details["cause"], "overview_open");
        assert_eq!(details["popup_present"], false);
    }
}

#[test]
fn a_closed_or_unreadable_overview_leaves_the_failure_unclaimed() {
    for overview in [Some(false), None] {
        let (error, reads) = failed_open(unverified("click"), None, &[], Some(&[]), overview);
        assert_eq!(reads, 1);
        assert!(
            error
                .suggestion
                .as_deref()
                .is_some_and(|text| text.starts_with("Inspect a fresh snapshot"))
        );
        let details = error.details.expect("evidence");
        assert_eq!(details["kind"], "popup_not_observed");
        assert!(details.get("cause").is_none());
    }
}

#[test]
fn an_open_overview_is_not_blamed_for_a_popup_that_stayed_open_or_was_not_read() {
    let popup = AtspiElement::new(":1.1", "/popup", 7);
    for (wanted, before, after) in [
        (Some(false), vec![popup.clone()], Some(vec![popup.clone()])),
        (None, vec![popup.clone()], Some(vec![popup])),
        (Some(true), vec![], None),
    ] {
        let (error, reads) = failed_open(
            unverified("collapse"),
            wanted,
            &before,
            after.as_deref(),
            Some(true),
        );
        assert_eq!(reads, 0);
        assert!(error.details.expect("evidence").get("cause").is_none());
    }
}

#[test]
fn naming_the_overview_gives_an_error_without_details_a_cause_and_leaves_others_alone() {
    let bare = AdapterError::new(ErrorCode::ActionFailed, "bare");
    let named = name_open_overview(bare.clone(), Some(true));
    assert_eq!(named.details.expect("cause")["cause"], "overview_open");
    for overview in [Some(false), None] {
        let left = name_open_overview(bare.clone(), overview);
        assert!(left.details.is_none());
        assert!(left.suggestion.is_none());
    }
}
