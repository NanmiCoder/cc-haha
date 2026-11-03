use crate::{AdapterError, AppError, KeyCombo, Modifier, adapter::PlatformAdapter};

/// Refuses `combo` when the platform adapter reports it as dangerous, unless
/// the caller forced it. Whether a combo is dangerous is the adapter's
/// decision (`is_blocked_combo`); core only enforces the verdict and honors
/// the `--force` override, so the calling agent always retains control.
pub fn ensure_combo_allowed(
    combo: &KeyCombo,
    raw: &str,
    force: bool,
    adapter: &dyn PlatformAdapter,
) -> Result<(), AppError> {
    if !force && adapter.is_blocked_combo(combo) {
        return Err(AppError::Adapter(AdapterError::policy_denied(format!(
            "Key combo '{raw}' is blocked for safety; pass --force to override"
        ))));
    }
    Ok(())
}

pub fn parse_combo_normalized(raw: &str) -> Result<KeyCombo, AppError> {
    let compact = raw.replace(' ', "");
    let mut combo = parse_combo(&compact.to_lowercase())?;
    if combo.modifiers.is_empty() && is_uppercase_letter(&compact) {
        combo.modifiers.push(Modifier::Shift);
    }
    Ok(combo)
}

fn is_uppercase_letter(key: &str) -> bool {
    let mut characters = key.chars();
    matches!(
        (characters.next(), characters.next()),
        (Some(only), None) if only.is_ascii_uppercase()
    )
}

pub fn parse_combo(s: &str) -> Result<KeyCombo, AppError> {
    let parts: Vec<&str> = s.split('+').collect();
    let key = parts
        .last()
        .copied()
        .filter(|k| !k.is_empty())
        .ok_or_else(|| AppError::invalid_input("Empty key combo"))?
        .to_string();
    let mut modifiers = Vec::new();

    for &part in &parts[..parts.len() - 1] {
        let modifier = match part {
            "meta" | "cmd" | "command" | "super" | "win" => Modifier::Meta,
            "ctrl" | "control" => Modifier::Ctrl,
            "alt" | "option" => Modifier::Alt,
            "shift" => Modifier::Shift,
            other => {
                return Err(AppError::invalid_input(format!(
                    "Unknown modifier: '{other}'"
                )));
            }
        };
        modifiers.push(modifier);
    }

    Ok(KeyCombo { key, modifiers })
}

#[cfg(test)]
#[path = "combo_tests.rs"]
mod tests;
