use agent_desktop_core::{Action, ActionRequest, DeliverySemantics, ErrorCode};

use super::live_bench::Toolkit;
use super::live_bench_iteration::each_scripts;
use super::live_widget_tests::widgets;
use crate::tree::vocabulary::role_numbers::PUSH_BUTTON;
use crate::tree::vocabulary::state_bits::FOCUSED;

#[test]
#[ignore = "drives real desktop applications; run through scripts/private-session.sh --wm"]
fn a_headed_set_focus_moves_the_focus_to_a_button_of_a_toolkit_that_grants_it() {
    each_scripts(
        &widgets(),
        &[Toolkit::Gtk3, Toolkit::Qt],
        |toolkit, bench| {
            let button = bench
                .find(PUSH_BUTTON, "Press me")
                .unwrap_or_else(|| panic!("{toolkit:?}: no button"));
            assert!(!bench.has_state(&button, FOCUSED), "{toolkit:?}: before");
            let headless = bench
                .act(&button, Action::SetFocus)
                .expect_err("headless focus is denied");
            assert_eq!(headless.code, ErrorCode::PolicyDenied, "{toolkit:?}");
            let headed = ActionRequest::headed(Action::SetFocus);
            let moved = bench
                .act_with(&button, headed.clone())
                .unwrap_or_else(|error| panic!("{toolkit:?}: {error}"));
            assert_eq!(
                moved.disposition(),
                DeliverySemantics::delivered_verified(),
                "{toolkit:?}"
            );
            assert_eq!(moved.steps[0].label(), "Component.GrabFocus", "{toolkit:?}");
            assert!(bench.has_state(&button, FOCUSED), "{toolkit:?}: after");
            let again = bench
                .act_with(&button, headed)
                .unwrap_or_else(|error| panic!("{toolkit:?}: {error}"));
            assert_eq!(
                again.disposition(),
                DeliverySemantics::not_delivered(),
                "{toolkit:?}: a node that holds focus is satisfied"
            );
        },
    );
}

#[test]
#[ignore = "drives real desktop applications; run through scripts/private-session.sh --wm"]
fn a_headed_set_focus_on_a_gtk4_button_names_the_rejection_and_moves_nothing() {
    each_scripts(&widgets(), &[Toolkit::Gtk4], |toolkit, bench| {
        let button = bench
            .find(PUSH_BUTTON, "Press me")
            .unwrap_or_else(|| panic!("{toolkit:?}: no button"));
        let error = bench
            .act_with(&button, ActionRequest::headed(Action::SetFocus))
            .expect_err("the GTK4 bridge rejects GrabFocus");
        assert_eq!(error.code, ErrorCode::ActionFailed, "{toolkit:?}");
        assert_eq!(
            error.disposition,
            DeliverySemantics::not_delivered(),
            "{toolkit:?}"
        );
        assert_eq!(
            error.details.expect("details")["cause"],
            "grab_focus_rejected",
            "{toolkit:?}"
        );
        let suggestion = error.suggestion.expect("a suggestion");
        assert!(suggestion.contains("focus-window"), "{suggestion}");
        assert!(!bench.has_state(&button, FOCUSED), "{toolkit:?}");
    });
}
