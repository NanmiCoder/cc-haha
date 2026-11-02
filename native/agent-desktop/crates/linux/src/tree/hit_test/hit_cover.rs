use crate::system::x11::X11Client;

/// The title of the covering window's client when it is the only client with
/// that process and title, which is exactly when it maps to one registry
/// frame (`match_client` pairs a frame with a client by those two). Two
/// clients sharing both leave the cover unnamed rather than guessed.
pub(crate) fn cover_name(clients: &[X11Client], window: u32) -> Option<String> {
    let cover = clients.iter().find(|client| client.id == window)?;
    let same = clients
        .iter()
        .filter(|client| client.pid == cover.pid && client.title == cover.title)
        .count();
    (same == 1 && !cover.title.is_empty()).then(|| cover.title.clone())
}

/// The title of an override-redirect cover, by the same rule: only when no
/// other client or override-redirect window carries it.
pub(crate) fn override_name(
    names: &[(u32, String)],
    clients: &[X11Client],
    window: u32,
) -> Option<String> {
    let (_, title) = names.iter().find(|(id, _)| *id == window)?;
    let others = names.iter().filter(|(_, other)| other == title).count()
        + clients
            .iter()
            .filter(|client| &client.title == title)
            .count();
    (others == 1).then(|| title.clone())
}
