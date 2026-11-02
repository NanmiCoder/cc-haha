use crate::system::x11::{MonitorFault, X11Monitor};

/// A source of the display server's monitor list, run on the bounded
/// reading thread so a display-server round trip can never stall the caller.
/// The error says why the list could not be read at all.
pub(crate) trait MonitorSource: Send + 'static {
    fn read(&self) -> Result<Vec<X11Monitor>, MonitorFault>;
}
