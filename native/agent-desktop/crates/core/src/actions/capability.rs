use crate::actions::action::Action;

pub const CLICK: &str = "Click";
pub const RIGHT_CLICK: &str = "RightClick";
pub const SET_VALUE: &str = "SetValue";
pub const SET_FOCUS: &str = "SetFocus";
pub const EXPAND: &str = "Expand";
pub const COLLAPSE: &str = "Collapse";
pub const SELECT: &str = "Select";
pub const TOGGLE: &str = "Toggle";
pub const SCROLL: &str = "Scroll";
pub const SCROLL_TO: &str = "ScrollTo";
pub const PRESS_KEY: &str = "PressKey";
pub const KEY_DOWN: &str = "KeyDown";
pub const KEY_UP: &str = "KeyUp";
pub const TYPE_TEXT: &str = "TypeText";
pub const HOVER: &str = "Hover";
pub const DRAG: &str = "Drag";
pub const CHECK: &str = "Check";
pub const UNCHECK: &str = "Uncheck";

pub const CHECKED_APPLICABILITY: &[&str] = &[TOGGLE, CHECK, UNCHECK];
pub const EXPANDED_APPLICABILITY: &[&str] = &[EXPAND, COLLAPSE];

pub fn for_action(action: &Action) -> &'static [&'static str] {
    match action {
        Action::Click | Action::DoubleClick | Action::TripleClick => &[CLICK],
        Action::RightClick => &[RIGHT_CLICK],
        Action::SetValue(_) | Action::Clear => &[SET_VALUE],
        Action::SetFocus => &[SET_FOCUS],
        Action::Expand => &[EXPAND],
        Action::Collapse => &[COLLAPSE],
        Action::Select(_) => &[SELECT, CLICK],
        Action::Toggle => &[TOGGLE, CLICK],
        Action::Check | Action::Uncheck => &[TOGGLE, CLICK],
        Action::Scroll(_, _) => &[SCROLL],
        Action::ScrollTo => &[SCROLL_TO],
        Action::PressKey(_) => &[PRESS_KEY],
        Action::KeyDown(_) => &[KEY_DOWN],
        Action::KeyUp(_) => &[KEY_UP],
        Action::TypeText(_) => &[TYPE_TEXT],
        Action::Hover => &[HOVER],
        Action::Drag(_) => &[DRAG],
    }
}

pub fn contains(actions: &[String], capability: &str) -> bool {
    actions.iter().any(|action| action == capability)
}

pub fn contains_any(actions: &[String], capabilities: &[&str]) -> bool {
    capabilities
        .iter()
        .any(|capability| contains(actions, capability))
}

pub(crate) fn supports_direct_semantic_pointer_delivery(
    action: &Action,
    available_actions: &[String],
) -> bool {
    let capability = match action {
        Action::Click => CLICK,
        Action::RightClick => RIGHT_CLICK,
        _ => return false,
    };
    contains(available_actions, capability)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{Direction, KeyCombo};

    #[test]
    fn action_capabilities_are_declared_in_one_place() {
        assert_eq!(for_action(&Action::Click), &[CLICK]);
        assert_eq!(for_action(&Action::RightClick), &[RIGHT_CLICK]);
        assert_eq!(for_action(&Action::SetValue("x".into())), &[SET_VALUE]);
        assert_eq!(for_action(&Action::Clear), &[SET_VALUE]);
        assert_eq!(for_action(&Action::Scroll(Direction::Down, 1)), &[SCROLL]);
        assert_eq!(
            for_action(&Action::PressKey(KeyCombo {
                key: "A".into(),
                modifiers: vec![],
            })),
            &[PRESS_KEY]
        );
    }

    #[test]
    fn direct_semantic_pointer_delivery_requires_an_exact_capability() {
        let click = vec![CLICK.to_string()];
        let right_click = vec![RIGHT_CLICK.to_string()];

        assert!(supports_direct_semantic_pointer_delivery(
            &Action::Click,
            &click
        ));
        assert!(supports_direct_semantic_pointer_delivery(
            &Action::RightClick,
            &right_click
        ));
        assert!(!supports_direct_semantic_pointer_delivery(
            &Action::DoubleClick,
            &click
        ));
        assert!(!supports_direct_semantic_pointer_delivery(
            &Action::TripleClick,
            &click
        ));
    }
}
