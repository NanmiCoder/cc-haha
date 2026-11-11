use crate::system::x11::stacking::overlays::Overlays;
use crate::system::x11::stacking::root_stack_evidence::RootStackEvidence;
use crate::system::x11::stacking::stack_selection::StackSelection;
use x11rb::protocol::xproto::{ConnectionExt, MapState, Window};
use x11rb::rust_connection::RustConnection;

use super::{Got, Stop};

fn unique_position(windows: &[Window], target: Window) -> Option<usize> {
    let mut positions = windows
        .iter()
        .enumerate()
        .filter_map(|(position, window)| (*window == target).then_some(position));
    let position = positions.next()?;
    positions.next().is_none().then_some(position)
}

pub(super) fn frame_of(connection: &RustConnection, root: Window, client: Window) -> Got<Window> {
    let parent = super::answer(connection.query_tree(client).ok())?.parent;
    Ok(if parent == root || parent == 0 {
        client
    } else {
        parent
    })
}

/// Selects a viewable override-redirect target from root sibling evidence,
/// retaining only managed clients whose root frames are above it.
fn select_override_target(
    target: Window,
    listed: &[Window],
    evidence: RootStackEvidence,
    overlays: Overlays,
) -> Option<StackSelection> {
    if !evidence.viewable || !evidence.override_redirect || listed.contains(&target) {
        return None;
    }
    let target_position = unique_position(&evidence.siblings, target)?;
    let mut selected = vec![target];
    for (index, client) in listed.iter().enumerate() {
        if listed[..index].contains(client) {
            return None;
        }
        let mut frames = evidence
            .managed_frames
            .iter()
            .filter_map(|(candidate, frame)| (*candidate == *client).then_some(*frame));
        let frame = frames.next()?;
        if frames.next().is_some() {
            return None;
        }
        if evidence
            .managed_frames
            .iter()
            .any(|(other, other_frame)| other != client && *other_frame == frame)
        {
            return None;
        }
        let frame_position = unique_position(&evidence.siblings, frame)?;
        if frame_position > target_position {
            selected.push(*client);
        }
    }
    Some(StackSelection {
        ids: selected,
        overlays,
    })
}

pub(super) fn read_override_selection(
    connection: &RustConnection,
    root: Window,
    target: Window,
    listed: &[Window],
) -> Got<StackSelection> {
    let attributes = super::answer(connection.get_window_attributes(target).ok())?;
    let siblings = super::answer(connection.query_tree(root).ok())?.children;
    let frame_reads = listed
        .iter()
        .map(|client| (*client, connection.query_tree(*client).ok()))
        .collect::<Vec<_>>();
    let managed_frames = frame_reads
        .into_iter()
        .map(|(client, read)| {
            let parent = super::answer(read)?.parent;
            Ok((
                client,
                if parent == root || parent == 0 {
                    client
                } else {
                    parent
                },
            ))
        })
        .collect::<Got<Vec<_>>>()?;
    let overlays = super::overlays_from_siblings(connection, &siblings, target)?;
    let evidence = RootStackEvidence {
        viewable: attributes.map_state == MapState::VIEWABLE,
        override_redirect: attributes.override_redirect,
        siblings,
        managed_frames,
    };
    select_override_target(target, listed, evidence, overlays).ok_or(Stop::Failed)
}

#[cfg(test)]
#[path = "stacking_wire_select_tests.rs"]
mod tests;
