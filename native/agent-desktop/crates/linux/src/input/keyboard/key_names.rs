use agent_desktop_core::{AdapterError, DeliverySemantics, ErrorCode, Modifier};

pub(crate) const KEYSYM_SHIFT_L: u32 = 0xffe1;
pub(crate) const KEYSYM_CONTROL_L: u32 = 0xffe3;
pub(crate) const KEYSYM_ALT_L: u32 = 0xffe9;
pub(crate) const KEYSYM_SUPER_L: u32 = 0xffeb;
pub(crate) const KEYSYM_RETURN: u32 = 0xff0d;
pub(crate) const KEYSYM_TAB: u32 = 0xff09;

const UNICODE_KEYSYM_BASE: u32 = 0x0100_0000;
const FIRST_FUNCTION_KEYSYM: u32 = 0xffbe;
const MAX_FUNCTION_KEY: u32 = 24;

const ACCEPTED_FORMS: &str = "a single character, f1-f24, return, tab, escape, space, backspace, delete (the backspace key), forwarddelete (the forward Delete key), home, end, pageup, pagedown, insert, left, up, right, down, ctrl, shift, alt, super, a punctuation name such as comma, greater or leftbracket, or an X keysym name such as Page_Up";

const NAMED_KEYS: &[(&str, u32)] = &[
    ("return", KEYSYM_RETURN),
    ("enter", KEYSYM_RETURN),
    ("tab", KEYSYM_TAB),
    ("escape", 0xff1b),
    ("esc", 0xff1b),
    ("space", 0x20),
    ("backspace", 0xff08),
    ("delete", 0xff08),
    ("home", 0xff50),
    ("left", 0xff51),
    ("up", 0xff52),
    ("right", 0xff53),
    ("down", 0xff54),
    ("pageup", 0xff55),
    ("pagedown", 0xff56),
    ("end", 0xff57),
    ("insert", 0xff63),
    ("ctrl", KEYSYM_CONTROL_L),
    ("control", KEYSYM_CONTROL_L),
    ("shift", KEYSYM_SHIFT_L),
    ("alt", KEYSYM_ALT_L),
    ("super", KEYSYM_SUPER_L),
    ("meta", KEYSYM_SUPER_L),
];

pub(crate) fn keysym_for_char(character: char) -> u32 {
    match character {
        '\n' => KEYSYM_RETURN,
        '\t' => KEYSYM_TAB,
        _ => {
            let code = u32::from(character);
            if (0x20..=0x7e).contains(&code) || (0xa0..=0xff).contains(&code) {
                code
            } else {
                UNICODE_KEYSYM_BASE + code
            }
        }
    }
}

pub(crate) fn keysym_for_key(name: &str) -> Result<u32, AdapterError> {
    let mut characters = name.chars();
    if let (Some(only), None) = (characters.next(), characters.next()) {
        return Ok(keysym_for_char(only));
    }
    let lowered = name.to_ascii_lowercase();
    if let Some((_, keysym)) = NAMED_KEYS.iter().find(|(known, _)| *known == lowered) {
        return Ok(*keysym);
    }
    if let Some(keysym) = super::keysym_names::lookup(&lowered) {
        return Ok(keysym);
    }
    if let Some(number) = function_key_number(&lowered) {
        return Ok(FIRST_FUNCTION_KEYSYM + number - 1);
    }
    Err(
        AdapterError::new(ErrorCode::InvalidArgs, format!("Unknown key name '{name}'"))
            .with_suggestion(format!("Use {ACCEPTED_FORMS}"))
            .with_disposition(DeliverySemantics::not_delivered()),
    )
}

fn function_key_number(lowered: &str) -> Option<u32> {
    let digits = lowered.strip_prefix('f')?;
    if digits.is_empty() || digits.starts_with('0') {
        return None;
    }
    let number: u32 = digits.parse().ok()?;
    (1..=MAX_FUNCTION_KEY).contains(&number).then_some(number)
}

pub(crate) fn modifier_keysym(modifier: &Modifier) -> u32 {
    match modifier {
        Modifier::Shift => KEYSYM_SHIFT_L,
        Modifier::Ctrl => KEYSYM_CONTROL_L,
        Modifier::Alt => KEYSYM_ALT_L,
        Modifier::Meta => KEYSYM_SUPER_L,
    }
}

#[cfg(test)]
#[path = "key_names_tests.rs"]
mod tests;
