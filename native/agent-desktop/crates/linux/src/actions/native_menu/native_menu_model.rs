use super::native_menu_action::ResolvedAction;
use super::native_menu_search::{Item, Menus, Search, find, link};
use std::collections::HashSet;
use zbus::zvariant::OwnedValue;

type Layout = Vec<(u32, u32, Vec<Item>)>;

pub(super) async fn resolve(
    connection: &zbus::Connection,
    bus: &str,
    path: &str,
    labels: &[String],
) -> Result<Option<ResolvedAction>, zbus::Error> {
    let proxy = zbus::Proxy::new(connection, bus, path, "org.gtk.Menus").await?;
    let mut groups = HashSet::new();
    let result = resolve_subscribed(&proxy, labels, &mut groups).await;
    if !groups.is_empty() {
        let mut subscribed: Vec<_> = groups.into_iter().collect();
        subscribed.sort_unstable();
        let ended: Result<(), zbus::Error> = proxy.call("End", &(subscribed,)).await;
        ended?;
    }
    result
}

async fn resolve_subscribed(
    proxy: &zbus::Proxy<'_>,
    labels: &[String],
    groups: &mut HashSet<u32>,
) -> Result<Option<ResolvedAction>, zbus::Error> {
    if labels.is_empty() || labels.len() > 16 {
        return Ok(None);
    }
    let mut menus = Menus::new();
    let mut root = (0, 0);
    let mut root_depth = 0;
    let mut ancestry = HashSet::new();
    let mut item_count = 0usize;
    for (index, label) in labels.iter().enumerate() {
        if !ancestry.insert(root) {
            return Ok(None);
        }
        let candidate = loop {
            match find(&menus, groups, root, root_depth, label) {
                Search::Load(group) => {
                    if groups.len() >= 32 {
                        return Ok(None);
                    }
                    groups.insert(group);
                    let layout: Layout = proxy.call("Start", &(vec![group],)).await?;
                    if layout.len() > 512 {
                        return Ok(None);
                    }
                    for (returned_group, menu, items) in layout {
                        item_count = item_count.saturating_add(items.len());
                        if returned_group != group
                            || item_count > 512
                            || menus.insert((returned_group, menu), items).is_some()
                        {
                            return Ok(None);
                        }
                    }
                }
                Search::Found(menu, item, depth) => {
                    root_depth = depth + 1;
                    break &menus[&menu][item];
                }
                Search::Invalid => return Ok(None),
            }
        };
        if index + 1 < labels.len() {
            let Some(submenu) = candidate.get(":submenu").and_then(link) else {
                return Ok(None);
            };
            root = submenu;
        } else {
            return Ok(resolve_action(candidate));
        }
    }
    Ok(None)
}

fn resolve_action(candidate: &Item) -> Option<ResolvedAction> {
    if candidate.contains_key(":submenu") || candidate.contains_key(":section") {
        return None;
    }
    let name = <&str>::try_from(candidate.get("action")?).ok()?;
    if name.is_empty() {
        return None;
    }
    let target = candidate
        .get("target")
        .map(OwnedValue::try_clone)
        .transpose()
        .ok()?;
    Some(ResolvedAction {
        name: name.to_owned(),
        target,
    })
}

#[cfg(test)]
#[path = "native_menu_model_tests.rs"]
mod tests;
