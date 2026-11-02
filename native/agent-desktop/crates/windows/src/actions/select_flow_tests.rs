use super::{SelectOps, SelectPlan, push_order, select_judged_for};
use crate::actions::chain::DeliveryOutcome;
use crate::system::fixture::test_time::deadline;
use agent_desktop_core::{AdapterError, DeliveryDisposition, ErrorCode};
use std::cell::Cell;

fn plan(self_match: bool, needs_expand: bool, value_chars: usize) -> SelectPlan {
    SelectPlan {
        self_match,
        needs_expand,
        value_chars,
    }
}

#[test]
fn first_match_still_realizes_before_select() {
    let finds = Cell::new(0u8);
    let realizes = Cell::new(0u8);
    let mut expand = || Ok(());
    let mut collapse = || {};
    let mut find = || {
        finds.set(finds.get() + 1);
        Ok(true)
    };
    let mut realize = || {
        realizes.set(realizes.get() + 1);
        Ok(())
    };
    let mut select_item = || Ok(DeliveryOutcome::DeliveredVerified);
    select_judged_for(
        deadline(5_000),
        plan(false, false, 3),
        SelectOps {
            expand: &mut expand,
            collapse: &mut collapse,
            find: &mut find,
            realize: &mut realize,
            select_item: &mut select_item,
        },
    )
    .expect("select");
    assert_eq!(finds.get(), 2);
    assert_eq!(realizes.get(), 1);
}

#[test]
fn mid_realize_search_ambiguity_aborts() {
    let mut expand = || Ok(());
    let mut collapse = || {};
    let mut find = || Ok(true);
    let mut realize = || {
        Err(AdapterError::ambiguous_target(
            "Multiple SelectionItem elements share the requested accessible name",
        )
        .with_details(serde_json::json!({
            "kind": "ambiguous_select_value",
        })))
    };
    let mut select_item = || Ok(DeliveryOutcome::DeliveredVerified);
    let error = select_judged_for(
        deadline(5_000),
        plan(false, false, 3),
        SelectOps {
            expand: &mut expand,
            collapse: &mut collapse,
            find: &mut find,
            realize: &mut realize,
            select_item: &mut select_item,
        },
    )
    .expect_err("ambiguous mid-realize");
    assert_eq!(error.code, ErrorCode::AmbiguousTarget);
}

#[test]
fn post_realize_duplicate_is_ambiguous() {
    let finds = Cell::new(0u8);
    let mut expand = || Ok(());
    let mut collapse = || {};
    let mut find = || {
        finds.set(finds.get() + 1);
        if finds.get() == 1 {
            Ok(true)
        } else {
            Err(AdapterError::ambiguous_target(
                "Multiple SelectionItem elements share the requested accessible name",
            )
            .with_details(serde_json::json!({
                "kind": "ambiguous_select_value",
            })))
        }
    };
    let mut realize = || Ok(());
    let mut select_item = || Ok(DeliveryOutcome::DeliveredVerified);
    let error = select_judged_for(
        deadline(5_000),
        plan(false, false, 3),
        SelectOps {
            expand: &mut expand,
            collapse: &mut collapse,
            find: &mut find,
            realize: &mut realize,
            select_item: &mut select_item,
        },
    )
    .expect_err("ambiguous after realize");
    assert_eq!(error.code, ErrorCode::AmbiguousTarget);
    assert_eq!(finds.get(), 2);
}

#[test]
fn miss_after_realize_still_collapses_when_expanded() {
    let order = Cell::new(Vec::<&'static str>::new());
    let mut expand = || {
        push_order(&order, "expand");
        Ok(())
    };
    let mut collapse = || {
        push_order(&order, "collapse");
    };
    let finds = Cell::new(0u8);
    let mut find = || {
        finds.set(finds.get() + 1);
        push_order(&order, "find");
        Ok(false)
    };
    let mut realize = || {
        push_order(&order, "realize");
        Ok(())
    };
    let mut select_item = || Ok(DeliveryOutcome::DeliveredVerified);
    let error = select_judged_for(
        deadline(5_000),
        plan(false, true, 7),
        SelectOps {
            expand: &mut expand,
            collapse: &mut collapse,
            find: &mut find,
            realize: &mut realize,
            select_item: &mut select_item,
        },
    )
    .expect_err("still missing");
    assert_eq!(error.code, ErrorCode::ElementNotFound);
    assert_eq!(finds.get(), 2);
    assert_eq!(
        order.take(),
        vec!["expand", "find", "realize", "find", "collapse"]
    );
    assert_eq!(
        error.disposition.delivery(),
        DeliveryDisposition::NotDelivered
    );
}
