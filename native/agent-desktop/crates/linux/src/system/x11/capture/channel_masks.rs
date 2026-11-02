use x11rb::protocol::xproto::{VisualClass, Visualtype};

pub(crate) fn masks_of(visual: &Visualtype) -> [u32; 3] {
    if visual.class == VisualClass::TRUE_COLOR {
        [visual.red_mask, visual.green_mask, visual.blue_mask]
    } else {
        [0; 3]
    }
}

#[cfg(test)]
#[path = "channel_masks_tests.rs"]
mod tests;
