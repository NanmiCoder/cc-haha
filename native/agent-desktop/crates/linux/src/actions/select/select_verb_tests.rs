use std::cell::Cell;

use super::*;
use agent_desktop_core::DeliverySemantics;

#[test]
fn an_option_toggle_selects_only_a_known_unselected_row() {
    for selected in [Some(true), Some(false), None] {
        let writes = Cell::new(0);
        let outcome = deliver(
            true,
            selected,
            || None,
            || {
                writes.set(writes.get() + 1);
                Ok(WriteReply::Done)
            },
            || Ok(Some(true)),
        );
        match selected {
            Some(true) => assert_eq!(outcome.unwrap(), DeliveryOutcome::Satisfied),
            Some(false) => assert_eq!(
                outcome.unwrap(),
                DeliveryOutcome::Delivered(Observed::Matched)
            ),
            None => assert_eq!(
                outcome.unwrap_err().disposition,
                DeliverySemantics::not_delivered()
            ),
        }
        assert_eq!(writes.get(), usize::from(selected == Some(false)));
    }
}

#[test]
fn an_already_selected_option_defers_extra_selection_to_the_container_route() {
    for (count, expected) in [
        (Some(1), Some(DeliveryOutcome::Satisfied)),
        (Some(2), Some(DeliveryOutcome::NotDelivered)),
        (None, None),
    ] {
        let result = deliver(
            true,
            Some(true),
            || Some(count),
            || panic!("must not toggle selected row"),
            || Ok(Some(true)),
        );
        match expected {
            Some(expected) => assert_eq!(result.unwrap(), expected),
            None => assert_eq!(
                result.unwrap_err().disposition,
                DeliverySemantics::not_delivered()
            ),
        }
    }
}

#[test]
fn an_already_highlighted_option_does_not_prove_a_committed_choice() {
    for observed in [Some(false), None] {
        let result = deliver(
            true,
            Some(true),
            || Some(Some(1)),
            || panic!("must not toggle the selected option"),
            || Ok(observed),
        );
        assert_eq!(
            result.unwrap_err().disposition,
            DeliverySemantics::not_delivered()
        );
    }
}
