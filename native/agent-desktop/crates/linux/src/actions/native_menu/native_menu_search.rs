use std::collections::{HashMap, HashSet};
use zbus::zvariant::{OwnedValue, Structure};

pub(super) type MenuId = (u32, u32);
pub(super) type Item = HashMap<String, OwnedValue>;
pub(super) type Menus = HashMap<MenuId, Vec<Item>>;

pub(super) enum Search {
    Load(u32),
    Found(MenuId, usize, usize),
    Invalid,
}

pub(super) fn find(
    menus: &Menus,
    groups: &HashSet<u32>,
    root: MenuId,
    root_depth: usize,
    label: &str,
) -> Search {
    let mut pending = vec![(root, root_depth)];
    let mut visited = HashSet::new();
    let mut found = None;
    while let Some((id, depth)) = pending.pop() {
        if depth >= 16 || !visited.insert(id) {
            return Search::Invalid;
        }
        if !groups.contains(&id.0) {
            return Search::Load(id.0);
        }
        let Some(items) = menus.get(&id) else {
            return Search::Invalid;
        };
        for (index, item) in items.iter().enumerate() {
            if let Some(section) = item.get(":section") {
                let Some(section) = link(section) else {
                    return Search::Invalid;
                };
                pending.push((section, depth + 1));
            }
            if item.get(":submenu").is_some_and(|v| link(v).is_none()) {
                return Search::Invalid;
            }
            if let Some(value) = item.get("label") {
                let Ok(text) = <&str>::try_from(value) else {
                    return Search::Invalid;
                };
                if strip_mnemonic(text).trim() == label.trim() {
                    if found.is_some() || item.contains_key(":section") {
                        return Search::Invalid;
                    }
                    found = Some((id, index, depth));
                }
            }
        }
    }
    match found {
        Some((menu, item, depth)) => Search::Found(menu, item, depth),
        None => Search::Invalid,
    }
}

pub(super) fn link(value: &OwnedValue) -> Option<MenuId> {
    let structure = <&Structure<'_>>::try_from(value).ok()?;
    let [group, menu] = structure.fields() else {
        return None;
    };
    Some((u32::try_from(group).ok()?, u32::try_from(menu).ok()?))
}

pub(super) fn strip_mnemonic(text: &str) -> String {
    let mut chars = text.chars();
    let mut result = String::new();
    while let Some(ch) = chars.next() {
        if ch == '_' {
            if let Some(next) = chars.next() {
                result.push(next);
            }
        } else {
            result.push(ch);
        }
    }
    result
}
