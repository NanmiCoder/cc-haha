use super::X11State;

/// Where window-manager properties come from. The real source talks to the
/// display server; tests supply a fixed answer.
pub(crate) trait X11Source: Send + 'static {
    fn read(&self) -> X11State;
}
