use super::shows_pointer;
use crate::Action;

#[test]
fn pressable_controls_show_the_pointer_however_they_are_reached() {
    for role in [
        "button",
        "link",
        "checkbox",
        "tab",
        "menuitem",
        "switch",
        "disclosure",
    ] {
        for action in [
            Action::Click,
            Action::ScrollTo,
            Action::SetFocus,
            Action::Toggle,
        ] {
            assert!(shows_pointer(role, &action), "{role} {action:?}");
        }
    }
}

#[test]
fn text_entry_keeps_the_arrow_even_when_clicked() {
    for role in ["textfield", "combobox", "datefield"] {
        for action in [Action::Click, Action::DoubleClick, Action::SetFocus] {
            assert!(!shows_pointer(role, &action), "{role} {action:?}");
        }
    }
}

#[test]
fn other_elements_show_the_pointer_only_when_clicked() {
    for role in ["group", "cell", "statictext", "unknown", "row"] {
        assert!(shows_pointer(role, &Action::Click), "{role}");
        assert!(shows_pointer(role, &Action::RightClick), "{role}");
        assert!(!shows_pointer(role, &Action::ScrollTo), "{role}");
        assert!(
            !shows_pointer(role, &Action::SetValue("x".into())),
            "{role}"
        );
    }
}

#[path = "presentation_lease_tests.rs"]
mod lease;

#[path = "presentation_shared_cursor_tests.rs"]
mod shared_cursor;

#[path = "presentation_caret_tests.rs"]
mod caret;
