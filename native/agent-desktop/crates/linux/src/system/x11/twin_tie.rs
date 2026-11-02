use super::map::{ClientMatch, match_client};
use super::{FrameFacts, X11Client};

/// The frames of one process that share one title, as the toolkit reports
/// them. Only they compete for the clients that share that title.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct Twins {
    /// Whether each of those frames is the one the toolkit reports active.
    pub(crate) active: Vec<bool>,
    /// The position among them of the frame being matched.
    pub(crate) me: usize,
}

/// The client of a frame whose process and title match several clients, when
/// every client is accounted for: the one frame the toolkit reports active is
/// the client the window manager reports active, and with exactly two such
/// frames the other frame is the other client. No accessibility field carries
/// the X11 window id and a toolkit that reports no global position gives every
/// window the same rectangle, so any other shape stays a tie.
pub(crate) fn broken_tie(ids: &[u32], active_client: Option<u32>, twins: &Twins) -> Option<u32> {
    let active_client = active_client.filter(|client| ids.contains(client))?;
    if twins.active.len() != ids.len() || twins.me >= twins.active.len() {
        return None;
    }
    let mut active = twins
        .active
        .iter()
        .enumerate()
        .filter(|(_, active)| **active)
        .map(|(index, _)| index);
    let (active_frame, None) = (active.next()?, active.next()) else {
        return None;
    };
    if active_frame == twins.me {
        return Some(active_client);
    }
    match ids {
        [first, second] => Some(if *first == active_client {
            *second
        } else {
            *first
        }),
        _ => None,
    }
}

/// The clients of a frame, with a tie between them broken when `twins` can
/// say which is which. `twins` is asked only for a tie.
pub(crate) fn client_among_twins(
    frame: &FrameFacts,
    clients: &[X11Client],
    active_client: Option<u32>,
    twins: impl FnOnce() -> Option<Twins>,
) -> ClientMatch {
    match match_client(frame, clients) {
        ClientMatch::Several(ids) => twins()
            .and_then(|twins| broken_tie(&ids, active_client, &twins))
            .map_or(ClientMatch::Several(ids), ClientMatch::One),
        other => other,
    }
}

/// What the tied clients agree on, as `read` reads it from each: `None` when
/// they differ or none is listed.
pub(crate) fn tied_agree<T: PartialEq>(
    clients: &[X11Client],
    ids: &[u32],
    read: impl Fn(&X11Client) -> T,
) -> Option<T> {
    let mut values = clients
        .iter()
        .filter(|client| ids.contains(&client.id))
        .map(read);
    let first = values.next()?;
    values.all(|other| other == first).then_some(first)
}

#[cfg(test)]
#[path = "twin_tie_tests.rs"]
mod tests;
