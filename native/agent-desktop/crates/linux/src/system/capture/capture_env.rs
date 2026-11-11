use super::window_context::{Decode, Encode, WindowLookup};
use crate::system::x11::capture::grab::Grabber;
use crate::system::x11::stacking::stacking_source::StackingSource;

/// Everything a capture reads from outside the process, behind seams a test
/// replaces.
pub(crate) struct CaptureEnv<'a> {
    pub(crate) grabber: &'a dyn Grabber,
    pub(crate) stacking: &'a dyn StackingSource,
    pub(crate) lookup: &'a dyn WindowLookup,
    pub(crate) decode: Decode,
    pub(crate) encode: Encode,
    pub(crate) stopped: fn(u32) -> bool,
}
