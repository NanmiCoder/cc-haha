use std::collections::HashSet;

use crate::system::registry::listed_window::ListedWindow;
use crate::system::x11::X11Client;
use crate::tree::Extents;

fn edges(bounds: Extents) -> Option<(i32, i32, i32, i32)> {
    if bounds.width <= 0 || bounds.height <= 0 || bounds.x == i32::MIN || bounds.y == i32::MIN {
        return None;
    }
    Some((
        bounds.x,
        bounds.y,
        bounds.x.checked_add(bounds.width)?,
        bounds.y.checked_add(bounds.height)?,
    ))
}

fn inside(inner: Extents, outer: Extents) -> bool {
    match (edges(inner), edges(outer)) {
        (Some((l, t, r, b)), Some((ol, ot, or, ob))) => l > ol && t > ot && r < or && b < ob,
        _ => false,
    }
}

/// Some toolkits expose embedded content as application-root frame siblings.
/// Only a complete one-to-one native-window projection can distinguish these
/// from another window. A modal, unread frame or unmatched native client
/// invalidates the whole projection instead of becoming an omitted window.
pub(super) fn classify(
    window: &ListedWindow,
    windows: &[ListedWindow],
    clients: &[X11Client],
    user_ids: &HashSet<u32>,
    helper_ids: &HashSet<u32>,
) -> Option<bool> {
    let pid = window.frame.pid;
    let peers: Vec<_> = windows
        .iter()
        .filter(|other| !other.unshown && other.frame.pid == pid)
        .collect();
    if peers
        .iter()
        .any(|peer| peer.info.state.visible.is_none() || peer.info.state.minimized.is_none())
    {
        return None;
    }
    let native: Vec<_> = clients
        .iter()
        .filter(|client| client.pid == Some(pid))
        .collect();
    let owned: HashSet<_> = native.iter().map(|client| client.id).collect();
    if user_ids.is_empty()
        || !user_ids.is_subset(&owned)
        || owned
            .iter()
            .any(|id| !user_ids.contains(id) && !helper_ids.contains(id))
    {
        return None;
    }
    let mut hosts: Vec<(&ListedWindow, Extents)> = Vec::new();
    for client in native.iter().filter(|client| user_ids.contains(&client.id)) {
        let bounds = client.bounds?;
        edges(bounds)?;
        let matching: Vec<_> = peers
            .iter()
            .copied()
            .filter(|peer| peer.frame.global_position && peer.frame.extents == Some(bounds))
            .collect();
        let [host] = matching.as_slice() else {
            return None;
        };
        if hosts.iter().any(|(other, _)| other.info.id == host.info.id)
            || native.iter().any(|other| {
                helper_ids.contains(&other.id)
                    && super::native_group::same_geometry(&host.frame, other)
            })
        {
            return None;
        }
        hosts.push((*host, bounds));
    }
    for peer in &peers {
        if hosts.iter().any(|(host, _)| host.info.id == peer.info.id) {
            continue;
        }
        let helpers: Vec<_> = native
            .iter()
            .filter(|client| {
                helper_ids.contains(&client.id)
                    && super::native_group::same_geometry(&peer.frame, client)
            })
            .collect();
        if !helpers.is_empty() {
            if helpers.len() != 1
                || peers
                    .iter()
                    .filter(|other| super::native_group::same_geometry(&other.frame, helpers[0]))
                    .count()
                    != 1
            {
                return None;
            }
            continue;
        }
        if peer.modal || peer.dialog || !peer.frame.global_position {
            return None;
        }
        let bounds = peer.frame.extents?;
        if hosts
            .iter()
            .filter(|(_, host)| inside(bounds, *host))
            .count()
            != 1
        {
            return None;
        }
    }
    Some(hosts.iter().any(|(host, _)| host.info.id == window.info.id))
}
