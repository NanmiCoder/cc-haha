use super::*;
use std::cell::Cell;

#[test]
fn select_descent_stops_reading_children_at_the_depth_cap() {
    let reads = Cell::new(0);
    let read = || {
        reads.set(reads.get() + 1);
        Ok(Vec::new())
    };

    boundary_children(MAX_SELECT_DEPTH - 1, SelectSearch::MenuItem, read).expect("below the cap");
    assert_eq!(reads.get(), 1);

    let capped = boundary_children(MAX_SELECT_DEPTH, SelectSearch::MenuItem, read)
        .expect("menu search ends quietly at the cap");
    assert!(capped.is_empty());
    assert_eq!(reads.get(), 1);

    let leaf = boundary_children(MAX_SELECT_DEPTH, SelectSearch::Collection, read)
        .expect("a collection leaf at the cap is not an overflow");
    assert!(leaf.is_empty());
    assert_eq!(reads.get(), 2);
}

#[test]
fn menu_items_are_pressed_without_setting_selected_first() {
    let selected_calls = Cell::new(0);
    let press_calls = Cell::new(0);

    let verified = deliver_candidate(
        false,
        || {
            selected_calls.set(selected_calls.get() + 1);
            Ok(Some(true))
        },
        || {
            press_calls.set(press_calls.get() + 1);
            Ok(true)
        },
    )
    .expect("menu candidate delivery");

    assert!(!verified);
    assert_eq!(selected_calls.get(), 0);
    assert_eq!(press_calls.get(), 1);
}

#[test]
fn collection_selection_falls_back_to_press_when_selected_write_fails() {
    let press_calls = Cell::new(0);
    let verified = deliver_candidate(
        true,
        || {
            Err(
                AdapterError::new(ErrorCode::ActionFailed, "AXSelected is unavailable")
                    .with_disposition(DeliverySemantics::not_delivered()),
            )
        },
        || {
            press_calls.set(press_calls.get() + 1);
            Ok(true)
        },
    )
    .expect("press fallback");

    assert!(!verified);
    assert_eq!(press_calls.get(), 1);
}

#[test]
fn uncertain_collection_selection_never_falls_back_to_press() {
    for disposition in [
        DeliverySemantics::uncertain(),
        DeliverySemantics::delivered_unverified(),
    ] {
        let presses = Cell::new(0);
        let result = deliver_candidate(
            true,
            || {
                Err(
                    AdapterError::new(ErrorCode::ActionFailed, "write uncertainty")
                        .with_disposition(disposition),
                )
            },
            || {
                presses.set(presses.get() + 1);
                Ok(true)
            },
        );
        assert_eq!(result.unwrap_err().disposition, disposition);
        assert_eq!(presses.get(), 0);
    }
}
