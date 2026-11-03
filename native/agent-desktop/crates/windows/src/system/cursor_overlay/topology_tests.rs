use super::DisplayTopology;
use crate::system::cursor_overlay::monitors::OverlayMonitor;
use agent_desktop_core::Rect;

fn one_screen(width: f64) -> Vec<OverlayMonitor> {
    let bounds = Rect {
        x: 0.0,
        y: 0.0,
        width,
        height: 1440.0,
    };
    vec![OverlayMonitor {
        work_area: bounds,
        bounds,
        scale: 1.0,
        is_primary: true,
    }]
}

fn topology(monitors: Vec<OverlayMonitor>, refresh_hz: u32) -> DisplayTopology {
    DisplayTopology {
        monitors,
        refresh_hz,
    }
}

/// An enumeration that fails is reported as an empty list, which reads exactly
/// like a desktop with no monitors. Adopting it sends every later frame to the
/// hardcoded fallback screen the paint path falls back to, and nothing puts
/// the real list back except a probe that happens to succeed.
#[test]
fn a_probe_that_enumerates_nothing_leaves_the_known_monitors_in_place() {
    let mut known = topology(one_screen(2560.0), 120);
    known.adopt(DisplayTopology {
        monitors: Vec::new(),
        refresh_hz: 60,
    });

    assert_eq!(known.monitors(), one_screen(2560.0).as_slice());
}

#[test]
fn a_probe_that_finds_a_changed_desktop_replaces_what_was_known() {
    let mut known = topology(one_screen(2560.0), 120);
    known.adopt(DisplayTopology {
        monitors: one_screen(1920.0),
        refresh_hz: 60,
    });

    assert_eq!(known.monitors(), one_screen(1920.0).as_slice());
    assert_eq!(known.refresh_hz(), 60);
}
