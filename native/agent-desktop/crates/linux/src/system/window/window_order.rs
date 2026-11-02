use std::cmp::Reverse;

use super::listed_twins::listed_client;
use crate::system::registry::listed_window::ListedWindow;
use crate::system::x11::X11State;
use crate::system::x11::map::ClientMatch;

/// How far above the bottom of the stacking order the client of window
/// `index` sits, or `None` when the window maps to no single client in the
/// stack.
fn height_in(
    windows: &[ListedWindow],
    index: usize,
    state: &X11State,
    stack: &[u32],
) -> Option<usize> {
    let ClientMatch::One(id) = listed_client(windows, index, state) else {
        return None;
    };
    stack.iter().rposition(|entry| *entry == id)
}

/// The windows from front to back: the focused window first, then the others
/// from the top of the stacking order to the bottom. A window with no single
/// client in the stack follows those that have one, in the order it was
/// listed; without a stacking order the listing order follows the focused
/// window.
pub(crate) fn front_to_back(
    windows: Vec<ListedWindow>,
    state: &X11State,
    stack: Option<&[u32]>,
) -> Vec<ListedWindow> {
    let heights: Vec<Option<usize>> = (0..windows.len())
        .map(|index| stack.and_then(|stack| height_in(&windows, index, state, stack)))
        .collect();
    let mut ranked: Vec<(ListedWindow, Option<usize>)> = windows.into_iter().zip(heights).collect();
    ranked.sort_by_key(|(window, height)| {
        (
            !window.info.state.is_focused,
            height.is_none(),
            Reverse(height.unwrap_or_default()),
        )
    });
    ranked.into_iter().map(|(window, _)| window).collect()
}

#[cfg(test)]
#[path = "window_order_tests.rs"]
mod tests;
