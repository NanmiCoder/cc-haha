use x11rb::protocol::xproto::{VisualClass, Visualtype};

use super::masks_of;

fn visual(class: VisualClass) -> Visualtype {
    Visualtype {
        visual_id: 1,
        class,
        bits_per_rgb_value: 8,
        colormap_entries: 256,
        red_mask: 0xff0000,
        green_mask: 0x00ff00,
        blue_mask: 0x0000ff,
    }
}

#[test]
fn any_other_class_gives_no_masks_so_conversion_refuses_it() {
    for class in [
        VisualClass::DIRECT_COLOR,
        VisualClass::PSEUDO_COLOR,
        VisualClass::STATIC_COLOR,
    ] {
        assert_eq!(masks_of(&visual(class)), [0; 3]);
    }
}
