use agent_desktop_core::actions::capability;

use super::menu_layout::LayoutEntry;

/// The capabilities an item has, from the methods it lists. `Click` means the
/// primary `Activate` and nothing else: `SecondaryActivate` is the middle
/// click, a different action, and never stands in for it.
pub(crate) fn actions(methods: &[String]) -> Vec<String> {
    let lists = |name: &str| methods.iter().any(|method| method == name);
    let mut actions = Vec::new();
    if lists("Activate") {
        actions.push(capability::CLICK.to_owned());
    }
    if lists("ContextMenu") {
        actions.push(capability::RIGHT_CLICK.to_owned());
    }
    actions
}

/// A menu entry other than a separator is clickable, enabled or not: whether
/// it can be picked now is its `enabled` state, which core's gate reads, so a
/// disabled entry gets the same enabled-check answer headless and headed and
/// never a hint to use `--headed` that cannot help.
pub(crate) fn entry_actions(entry: &LayoutEntry) -> Vec<String> {
    if !entry.separator {
        vec![capability::CLICK.to_owned()]
    } else {
        Vec::new()
    }
}
