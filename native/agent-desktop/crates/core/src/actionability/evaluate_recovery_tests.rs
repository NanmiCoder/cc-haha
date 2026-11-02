use super::*;
use crate::{Action, InteractionPolicy, Rect};

fn unsupported(action: Action, policy: InteractionPolicy) -> AdapterError {
    let evidence = ActionabilityEvidence {
        nonspatial: false,
        state: crate::ElementState {
            role: "textfield".into(),
            states: Vec::new(),
            value: None,
            enabled: Some(true),
            hidden: Some(false),
            offscreen: Some(false),
        },
        states_complete: true,
        bounds: Some(Rect {
            x: 0.0,
            y: 0.0,
            width: 100.0,
            height: 20.0,
        }),
        available_actions: Vec::new(),
    };
    let mut request = ActionRequest::headless(action);
    request.policy = policy;
    let error = check_with_stability(
        StabilityExpectation::permissive(None),
        &evidence,
        &request,
        None,
        crate::Deadline::standard().unwrap(),
    )
    .unwrap_err();
    assert_eq!(error.code, ErrorCode::ActionNotSupported);
    assert_eq!(error.disposition, crate::DeliverySemantics::not_delivered());
    error
}

#[test]
fn unsupported_focus_names_a_supported_target_instead_of_repeating_headed() {
    for policy in [InteractionPolicy::headless(), InteractionPolicy::headed()] {
        let hint = unsupported(Action::SetFocus, policy).suggestion.unwrap();
        assert!(hint.contains("SetFocus"), "{hint}");
        assert!(hint.contains("focus-window"), "{hint}");
        assert!(!hint.contains("--headed"), "{hint}");
    }
}

#[test]
fn unsupported_text_write_names_typing_for_the_actual_mode_and_a_paste_fallback() {
    for action in [Action::SetValue("search".into()), Action::Clear] {
        for policy in [
            InteractionPolicy::headless(),
            InteractionPolicy::focus_fallback(),
            InteractionPolicy::headed(),
        ] {
            let hint = unsupported(action.clone(), policy).suggestion.unwrap();
            assert_eq!(
                hint.contains("--headed type"),
                !policy.is_headed(),
                "{hint}"
            );
            assert_eq!(
                hint.contains("current headed mode"),
                policy.is_headed(),
                "{hint}"
            );
            assert!(hint.contains("clipboard-set"), "{hint}");
            assert!(hint.contains("paste shortcut"), "{hint}");
        }
    }
}
