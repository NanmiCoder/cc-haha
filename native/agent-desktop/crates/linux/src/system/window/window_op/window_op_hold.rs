use super::*;

pub(super) fn confirm_rectangle(
    world: &impl OpWorld,
    client: u32,
    first: WindowFacts,
    deadline: Deadline,
) -> (bool, Option<WindowFacts>) {
    if deadline.remaining() < CONFIRM_PAUSE {
        return (false, Some(first));
    }
    std::thread::sleep(CONFIRM_PAUSE);
    let next = world.facts(client).ready();
    let stable = !deadline.is_expired() && next.is_some_and(|next| next.client == first.client);
    (stable, next)
}

/// Puts the client at `place`, with a second try through a place 40 px away
/// where the manager skips a move to the place it believes the window holds.
pub(super) fn move_client(
    world: &impl OpWorld,
    win: &WindowInfo,
    client: u32,
    place: Extents,
    deadline: Deadline,
) -> Result<(), AdapterError> {
    let back = move_to(place.x, place.y);
    let there = matches!(
        world.facts(client),
        ControlRead::Ready(facts)
            if (facts.client.x - place.x).abs() <= POSITION_TOLERANCE
                && (facts.client.y - place.y).abs() <= POSITION_TOLERANCE
                && confirm_rectangle(world, client, facts, deadline).0
    );
    if !there && apply(world, win, client, &back, deadline).is_err() {
        let _ = apply(
            world,
            win,
            client,
            &move_to(place.x + NUDGE, place.y),
            deadline,
        );
        apply(world, win, client, &back, deadline)?;
    }
    Ok(())
}

pub(super) fn give_back_place(
    world: &impl OpWorld,
    win: &WindowInfo,
    client: u32,
    deadline: Deadline,
) -> Result<(), AdapterError> {
    let Some(place) = world.remembered(win, client) else {
        return Ok(());
    };
    move_client(world, win, client, place, deadline)?;
    world.remember(win, client, None);
    Ok(())
}

/// Whether a window of `size` can sit at `place` on one display. A window the
/// displays cannot hold there is placed by the manager as it likes, so the
/// place it was given is no measure of it. Without a display list the place is
/// taken to hold it.
pub(super) fn holds_place(place: &Extents, size: &Extents, displays: &[Rect]) -> bool {
    displays.is_empty()
        || displays.iter().any(|display| {
            f64::from(place.x) >= display.x
                && f64::from(place.y) >= display.y
                && f64::from(place.x) + f64::from(size.width) <= display.x + display.width
                && f64::from(place.y) + f64::from(size.height) <= display.y + display.height
        })
}

pub(super) fn is_resize(write: &WindowWrite) -> bool {
    matches!(
        write,
        WindowWrite::MoveResize {
            x: None,
            y: None,
            width: Some(_),
            height: Some(_)
        }
    )
}

pub(super) fn move_to(x: i32, y: i32) -> WindowWrite {
    WindowWrite::MoveResize {
        x: Some(x),
        y: Some(y),
        width: None,
        height: None,
    }
}

pub(super) fn remember_place(world: &impl OpWorld, win: &WindowInfo, client: u32) {
    if let ControlRead::Ready(facts) = world.facts(client)
        && !facts.maximized_vertical
        && !facts.maximized_horizontal
        && !facts.hidden
    {
        world.remember(win, client, Some(facts.client));
    }
}
