use crate::convert::string::c_to_string;
use crate::types::{AdAction, AdActionKind, AdDirection, AdKeyCombo, AdModifier};
use agent_desktop_core::{Action, Direction, KeyCombo as CoreKeyCombo, Modifier};

/// Four modifier keys exist (`AdModifier::{Meta, Ctrl, Alt, Shift}`),
/// so a combo can name at most four. Anything larger must be bogus
/// input — bail out instead of trusting it into `from_raw_parts`.
const MAX_MODIFIERS_PER_COMBO: u32 = 4;

pub(crate) unsafe fn key_combo_from_c(k: &AdKeyCombo) -> Result<CoreKeyCombo, &'static str> {
    unsafe {
        let key = c_to_string(k.key).ok_or("key is null or invalid UTF-8")?;

        if k.modifier_count > MAX_MODIFIERS_PER_COMBO {
            return Err("modifier_count exceeds MAX_MODIFIERS_PER_COMBO (4)");
        }
        if k.modifier_count > 0 && k.modifiers.is_null() {
            return Err("modifier_count > 0 but modifiers pointer is null");
        }

        let mut modifiers = Vec::with_capacity(k.modifier_count as usize);
        if k.modifier_count > 0 {
            let slice = std::slice::from_raw_parts(k.modifiers, k.modifier_count as usize);
            for raw_modifier in slice {
                let m = AdModifier::from_c(*raw_modifier).ok_or("invalid modifier discriminant")?;
                let modifier = match m {
                    AdModifier::Meta => Modifier::Meta,
                    AdModifier::Ctrl => Modifier::Ctrl,
                    AdModifier::Alt => Modifier::Alt,
                    AdModifier::Shift => Modifier::Shift,
                };
                modifiers.push(modifier);
            }
        }
        Ok(CoreKeyCombo { key, modifiers })
    }
}

pub(crate) unsafe fn action_from_c(action: &AdAction) -> Result<Action, &'static str> {
    unsafe {
        let kind = AdActionKind::from_c(action.kind).ok_or("invalid action kind discriminant")?;
        match kind {
            AdActionKind::Click => Ok(Action::Click),
            AdActionKind::DoubleClick => Ok(Action::DoubleClick),
            AdActionKind::RightClick => Ok(Action::RightClick),
            AdActionKind::TripleClick => Ok(Action::TripleClick),
            AdActionKind::SetFocus => Ok(Action::SetFocus),
            AdActionKind::Expand => Ok(Action::Expand),
            AdActionKind::Collapse => Ok(Action::Collapse),
            AdActionKind::Toggle => Ok(Action::Toggle),
            AdActionKind::Check => Ok(Action::Check),
            AdActionKind::Uncheck => Ok(Action::Uncheck),
            AdActionKind::ScrollTo => Ok(Action::ScrollTo),
            AdActionKind::Clear => Ok(Action::Clear),
            AdActionKind::Hover => Ok(Action::Hover),
            AdActionKind::SetValue => {
                let text = c_to_string(action.text).ok_or("text is null or invalid UTF-8")?;
                Ok(Action::SetValue(text))
            }
            AdActionKind::Select => {
                let text = c_to_string(action.text).ok_or("text is null or invalid UTF-8")?;
                Ok(Action::Select(text))
            }
            AdActionKind::TypeText => {
                let text = c_to_string(action.text).ok_or("text is null or invalid UTF-8")?;
                Ok(Action::TypeText(text))
            }
            AdActionKind::Scroll => {
                let dir = match AdDirection::from_c(action.scroll.direction)
                    .ok_or("invalid scroll direction discriminant")?
                {
                    AdDirection::Up => Direction::Up,
                    AdDirection::Down => Direction::Down,
                    AdDirection::Left => Direction::Left,
                    AdDirection::Right => Direction::Right,
                };
                Ok(Action::Scroll(dir, action.scroll.amount))
            }
            AdActionKind::PressKey => {
                let combo = key_combo_from_c(&action.key)?;
                Ok(Action::PressKey(combo))
            }
            AdActionKind::KeyDown => {
                let combo = key_combo_from_c(&action.key)?;
                Ok(Action::KeyDown(combo))
            }
            AdActionKind::KeyUp => {
                let combo = key_combo_from_c(&action.key)?;
                Ok(Action::KeyUp(combo))
            }
            AdActionKind::Drag => Ok(Action::Drag(action.drag.to_core())),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::convert::string::{free_c_string, string_to_c};
    use crate::{AdDragParams, AdPoint, AdScrollParams};
    use std::ptr;

    fn make_scroll_params() -> AdScrollParams {
        AdScrollParams {
            direction: AdDirection::Down as i32,
            amount: 3,
        }
    }

    fn make_key_combo() -> AdKeyCombo {
        AdKeyCombo {
            key: ptr::null(),
            modifiers: ptr::null(),
            modifier_count: 0,
        }
    }

    fn make_drag_params() -> AdDragParams {
        AdDragParams {
            from: AdPoint { x: 0.0, y: 0.0 },
            to: AdPoint { x: 0.0, y: 0.0 },
            duration_ms: 0,
            drop_delay_ms: 0,
        }
    }

    #[test]
    fn test_simple_action_roundtrip() {
        let action = AdAction {
            kind: AdActionKind::Click as i32,
            text: ptr::null(),
            scroll: make_scroll_params(),
            key: make_key_combo(),
            drag: make_drag_params(),
        };
        let result = unsafe { action_from_c(&action) };
        assert!(result.is_ok());
        assert!(matches!(result.unwrap(), Action::Click));
    }

    #[test]
    fn test_set_value_action() {
        let text = string_to_c("hello world");
        let action = AdAction {
            kind: AdActionKind::SetValue as i32,
            text,
            scroll: make_scroll_params(),
            key: make_key_combo(),
            drag: make_drag_params(),
        };
        let result = unsafe { action_from_c(&action) };
        assert!(result.is_ok());
        assert!(matches!(result.unwrap(), Action::SetValue(ref s) if s == "hello world"));
        unsafe { free_c_string(text as *mut _) };
    }

    #[test]
    fn test_scroll_action() {
        let action = AdAction {
            kind: AdActionKind::Scroll as i32,
            text: ptr::null(),
            scroll: AdScrollParams {
                direction: AdDirection::Up as i32,
                amount: 5,
            },
            key: make_key_combo(),
            drag: make_drag_params(),
        };
        let result = unsafe { action_from_c(&action) };
        assert!(result.is_ok());
        assert!(matches!(result.unwrap(), Action::Scroll(Direction::Up, 5)));
    }

    #[test]
    fn key_combo_rejects_modifier_count_exceeding_cap() {
        let key = string_to_c("a");
        let modifiers = [
            AdModifier::Meta as i32,
            AdModifier::Ctrl as i32,
            AdModifier::Alt as i32,
            AdModifier::Shift as i32,
            AdModifier::Meta as i32,
        ];
        let combo = AdKeyCombo {
            key,
            modifiers: modifiers.as_ptr(),
            modifier_count: modifiers.len() as u32,
        };
        let result = unsafe { key_combo_from_c(&combo) };
        let message = result.expect_err("five modifiers must be rejected");
        assert!(
            message.contains("MAX_MODIFIERS_PER_COMBO"),
            "got: {message}"
        );
        unsafe { free_c_string(key as *mut _) };
    }

    #[test]
    fn key_combo_rejects_positive_count_with_null_pointer() {
        let key = string_to_c("a");
        let combo = AdKeyCombo {
            key,
            modifiers: ptr::null(),
            modifier_count: 2,
        };
        let result = unsafe { key_combo_from_c(&combo) };
        assert!(result.is_err());
        unsafe { free_c_string(key as *mut _) };
    }

    #[test]
    fn key_combo_accepts_valid_modifier_slice() {
        let key = string_to_c("s");
        let mods: [i32; 2] = [AdModifier::Meta as i32, AdModifier::Shift as i32];
        let combo = AdKeyCombo {
            key,
            modifiers: mods.as_ptr(),
            modifier_count: 2,
        };
        let result = unsafe { key_combo_from_c(&combo) }.unwrap();
        assert_eq!(result.key, "s");
        assert_eq!(result.modifiers.len(), 2);
        unsafe { free_c_string(key as *mut _) };
    }
}
