/// Which bus a failed connection was aimed at, so one D-Bus error can name the right fault.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum Stage {
    SessionBus,
    AccessibilityBus,
}
