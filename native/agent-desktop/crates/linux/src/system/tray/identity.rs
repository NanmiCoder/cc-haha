use super::TrayTarget;

const PREFIX: &str = "tray:";

pub(super) fn is_tray_id(value: &str) -> bool {
    value.starts_with(PREFIX)
}

pub(super) fn encode(target: &TrayTarget) -> String {
    let value = serde_json::json!({
        "owner": target.owner,
        "object_path": target.object_path,
        "menu_path": target.menu_path,
        "entry_id": target.entry_id,
        "label_path": target.label_path,
    });
    format!("{PREFIX}{value}")
}

pub(super) fn decode(value: &str) -> Option<TrayTarget> {
    let body = value.strip_prefix(PREFIX)?;
    let target: TrayTarget = serde_json::from_str(body).ok()?;
    (!target.owner.is_empty()
        && target.object_path.starts_with('/')
        && target.menu_path.is_some() == target.entry_id.is_some()
        && target
            .menu_path
            .as_deref()
            .is_none_or(|path| path.starts_with('/'))
        && target.entry_id.is_none() == target.label_path.is_empty())
    .then_some(target)
}

#[cfg(test)]
#[path = "identity_tests.rs"]
mod tests;
