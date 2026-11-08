use agent_desktop_core::{KeyCombo, Modifier};

const FIRST_VIRTUAL_TERMINAL_KEYSYM: u32 = 0xffbe;
const LAST_VIRTUAL_TERMINAL_KEYSYM: u32 = 0xffc9;
const LOWERCASE_OFFSET: u32 = 0x20;

pub(crate) fn is_blocked(combo: &KeyCombo) -> bool {
    let Ok(key) = super::keyboard::key_names::keysym_for_key(&combo.key).map(fold_case) else {
        return false;
    };
    let held = |needed: &[Modifier]| {
        needed
            .iter()
            .all(|modifier| combo.modifiers.contains(modifier))
    };
    match key {
        0xffc1 | 0xff09 | 0xffbf if held(&[Modifier::Alt]) => true,
        0x6c | 0x64 | 0xff09 if held(&[Modifier::Meta]) => true,
        0x74 | 0xff08 | 0xffff | 0x6c if held(&[Modifier::Ctrl, Modifier::Alt]) => true,
        key if held(&[Modifier::Ctrl, Modifier::Alt])
            && (FIRST_VIRTUAL_TERMINAL_KEYSYM..=LAST_VIRTUAL_TERMINAL_KEYSYM).contains(&key) =>
        {
            true
        }
        0xffeb => true,
        _ => false,
    }
}

fn fold_case(keysym: u32) -> u32 {
    if (0x41..=0x5a).contains(&keysym) {
        keysym + LOWERCASE_OFFSET
    } else {
        keysym
    }
}

#[cfg(test)]
#[path = "blocked_combo_tests.rs"]
mod tests;
