use super::Desktops;
use crate::system::x11::window::desktop_placement::DesktopPlacement;

fn desktops(current: Option<u32>) -> Desktops {
    Desktops {
        current,
        placements: vec![
            (1, DesktopPlacement::On(0)),
            (2, DesktopPlacement::On(1)),
            (3, DesktopPlacement::Sticky),
            (4, DesktopPlacement::Unknown),
        ],
    }
}

#[test]
fn a_window_on_another_desktop_is_hidden_by_it() {
    let shown = desktops(Some(0));
    assert!(!shown.hides(1));
    assert!(shown.hides(2));
}

#[test]
fn a_sticky_or_unplaced_window_is_never_hidden_by_the_desktop() {
    let shown = desktops(Some(1));
    assert!(!shown.hides(3));
    assert!(!shown.hides(4));
    assert!(!shown.hides(99));
}

#[test]
fn without_a_current_desktop_nothing_is_hidden() {
    assert!(!desktops(None).hides(2));
}
