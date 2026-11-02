//! Windows-dangerous key combos.
//!
//! `is_blocked_combo`'s core default blocks nothing
//! (`crates/core/src/adapter/system.rs`); the Windows adapter's
//! `is_blocked_combo` override calls this module to supply the list. The list
//! is reasoned from Windows semantics, not
//! translated from macOS's `cmd+q`-shaped set, which has no Windows meaning.
//! One question decides membership: does the shortcut take the foreground
//! away from the run, or change the session out from under it? `alt+f4`
//! closes the active window, `win+l` locks the session, `win+d` shows the
//! desktop, and `alt+tab` steals the foreground mid-run. `win+r` (Run),
//! `win+x` (Quick Link), `win+e` (File Explorer) and `ctrl+shift+esc` (Task
//! Manager) each raise a shell surface over the target and answer that same
//! question the same way, so they are listed for the same reason rather than
//! left out because they open something rather than close it. Every
//! modifier order, key-name alias, and modifier superset of a blocked
//! shortcut is caught by canonicalizing before comparison - the superset
//! rule is this list's own, because `alt+shift+tab` is as dangerous as the
//! `alt+tab` it extends. `ctrl+alt+delete` is
//! deliberately absent: it is the Secure Attention Sequence, which
//! `SendInput` cannot synthesize at all, so listing it here would advertise
//! a guard this adapter does not provide. The calling agent can still send
//! any of these with `--force`, which core enforces.

use agent_desktop_core::{KeyCombo, Modifier};

const BLOCKED: &[&str] = &[
    "alt+f4",
    "win+l",
    "win+d",
    "alt+tab",
    "win+r",
    "win+x",
    "win+e",
    "ctrl+shift+esc",
];

/// Blocks a combo whose key matches a listed shortcut and whose modifiers
/// are a superset of that shortcut's.
///
/// Exact equality is not enough: adding a modifier to a dangerous shortcut
/// usually produces another dangerous shortcut rather than a harmless one.
/// `alt+shift+tab` is the reverse task switcher and steals the foreground
/// exactly as `alt+tab` does, but it is a different string, so an
/// equality check waves it through. Superset matching over-blocks a few
/// combinations nobody uses - `ctrl+alt+f4` - and that trade is deliberate:
/// a wrongly blocked combo costs the caller one `--force`, while a wrongly
/// allowed one moves input to another window in the middle of a run.
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
        Modifier::Meta => "win",
        Modifier::Ctrl => "ctrl",
        Modifier::Alt => "alt",
        Modifier::Shift => "shift",
    }
}

/// Canonicalizes a `mod+...+key` string for safety comparison and returns
/// its parts: modifier names normalized, sorted and de-duplicated so order
/// and spelling cannot evade a match, and the single key folded to one
/// spelling per physical key. `meta`/`cmd` fold to `win` because the agent
/// may name the Windows key either way even though the shortcut itself only
/// exists on Windows. The parts stay separate rather than joined so the
/// comparison can ask about modifiers and key independently, which is what
/// superset matching needs.
fn canonical_parts(raw: &str) -> (Vec<String>, String) {
    let lower = raw.to_lowercase();
    let mut mods: Vec<String> = Vec::new();
    let mut key = String::new();
    for part in lower.split('+') {
        match part {
            "win" | "meta" | "cmd" | "super" => mods.push("win".to_string()),
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
