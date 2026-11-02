use agent_desktop_core::{KeyCombo, Modifier};

const BLOCKED: &[&str] = &[
    "cmd+q",
    "cmd+shift+q",
    "cmd+alt+esc",
    "ctrl+cmd+q",
    "cmd+shift+delete",
];

/// Reports whether `combo` is one of the macOS shortcuts that would quit, log
/// out, force-quit, or lock the session. Comparison is canonical, so every
/// modifier order and key-name alias of a blocked shortcut is caught.
///
/// A combo is blocked if its key matches a listed shortcut and its modifiers
/// are a superset of that shortcut's modifiers. Adding a modifier to a
/// dangerous shortcut usually produces another dangerous shortcut rather than
/// a harmless one: `cmd+shift+q` force-quits like `cmd+q`. Superset matching
/// catches these cases and over-blocks a few combinations nobody uses, which
/// trades a wrong-block for a correct deny and costs the caller one `--force`.
/// The calling agent can still send any of these by passing `--force`.
pub(crate) fn is_blocked(combo: &KeyCombo) -> bool {
    let (modifiers, key) = canonical_parts(&combo_to_string(combo));
    BLOCKED.iter().any(|entry| {
        let (blocked_modifiers, blocked_key) = canonical_parts(entry);
        blocked_key == key
            && blocked_modifiers
                .iter()
                .all(|needed| modifiers.contains(needed))
    })
}

fn combo_to_string(combo: &KeyCombo) -> String {
    let mut parts: Vec<&str> = combo.modifiers.iter().map(modifier_name).collect();
    parts.push(combo.key.as_str());
    parts.join("+")
}

fn modifier_name(modifier: &Modifier) -> &'static str {
    match modifier {
        Modifier::Meta => "cmd",
        Modifier::Ctrl => "ctrl",
        Modifier::Alt => "alt",
        Modifier::Shift => "shift",
    }
}

/// Canonicalizes a `mod+...+key` string for safety comparison and returns
/// its parts: modifier names normalized, sorted and de-duplicated so order
/// and spelling cannot evade a match, and the single key folded to one
/// spelling per physical key. The parts stay separate rather than joined so the
/// comparison can ask about modifiers and key independently, which is what
/// superset matching needs.
fn canonical_parts(raw: &str) -> (Vec<String>, String) {
    let lower = raw.to_lowercase();
    let mut mods: Vec<String> = Vec::new();
    let mut key = String::new();
    for part in lower.split('+') {
        match part {
            "cmd" | "command" => mods.push("cmd".to_string()),
            "ctrl" | "control" => mods.push("ctrl".to_string()),
            "alt" | "option" => mods.push("alt".to_string()),
            "shift" => mods.push("shift".to_string()),
            other => key = canonical_key(other).to_string(),
        }
    }
    mods.sort_unstable();
    mods.dedup();
    (mods, key)
}

fn canonical_key(key: &str) -> &str {
    match key {
        "escape" | "esc" => "esc",
        "backspace" | "delete" => "delete",
        "enter" | "return" => "return",
        other => other,
    }
}

#[cfg(test)]
#[path = "blocked_combo_tests.rs"]
mod tests;
