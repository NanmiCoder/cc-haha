use x11rb::protocol::xproto::{ImageOrder, Setup};

use super::channel_masks::masks_of;
use crate::system::capture::pixels::VisualFormat;

pub(crate) fn format_of(setup: &Setup, depth: u8, visual_id: u32) -> Option<VisualFormat> {
    let visual = setup
        .roots
        .iter()
        .flat_map(|screen| screen.allowed_depths.iter())
        .flat_map(|depth| depth.visuals.iter())
        .find(|visual| visual.visual_id == visual_id)?;
    let format = setup
        .pixmap_formats
        .iter()
        .find(|format| format.depth == depth)?;
    let [red_mask, green_mask, blue_mask] = masks_of(visual);
    Some(VisualFormat {
        red_mask,
        green_mask,
        blue_mask,
        bits_per_pixel: format.bits_per_pixel,
        depth,
        scanline_pad: format.scanline_pad,
        msb_first: setup.image_byte_order == ImageOrder::MSB_FIRST,
    })
}
