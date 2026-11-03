use super::*;

fn le32() -> VisualFormat {
    VisualFormat {
        red_mask: 0x00ff_0000,
        green_mask: 0x0000_ff00,
        blue_mask: 0x0000_00ff,
        bits_per_pixel: 32,
        depth: 24,
        scanline_pad: 32,
        msb_first: false,
    }
}

const COLOURS: [[u8; 3]; 4] = [[255, 0, 0], [0, 255, 0], [0, 0, 255], [10, 20, 30]];

fn bgrx(colours: &[[u8; 3]]) -> Vec<u8> {
    colours
        .iter()
        .flat_map(|[r, g, b]| [*b, *g, *r, 0])
        .collect()
}

fn flat(colours: &[[u8; 3]]) -> Vec<u8> {
    colours.iter().flatten().copied().collect()
}

#[test]
fn four_distinct_little_endian_pixels_convert_to_their_colours() {
    let data = bgrx(&COLOURS);
    assert_eq!(to_rgb(&le32(), &data, 2, 2, 8).unwrap(), flat(&COLOURS));
}

#[test]
fn the_masks_decide_which_channel_is_red() {
    let mut format = le32();
    format.red_mask = 0x0000_00ff;
    format.blue_mask = 0x00ff_0000;
    let data = bgrx(&COLOURS);
    let swapped: Vec<[u8; 3]> = COLOURS.iter().map(|[r, g, b]| [*b, *g, *r]).collect();
    assert_eq!(to_rgb(&format, &data, 2, 2, 8).unwrap(), flat(&swapped));
}

#[test]
fn big_endian_image_byte_order_is_read_most_significant_byte_first() {
    let mut format = le32();
    format.msb_first = true;
    let data: Vec<u8> = COLOURS
        .iter()
        .flat_map(|[r, g, b]| [0, *r, *g, *b])
        .collect();
    assert_eq!(to_rgb(&format, &data, 2, 2, 8).unwrap(), flat(&COLOURS));
}

#[test]
fn row_padding_beyond_the_pixels_is_skipped() {
    let rows = [
        [1, 2, 3],
        [4, 5, 6],
        [7, 8, 9],
        [11, 12, 13],
        [14, 15, 16],
        [17, 18, 19],
    ];
    let mut data = Vec::new();
    for row in rows.chunks(3) {
        data.extend(bgrx(row));
        data.extend([0xee; 4]);
    }
    assert_eq!(to_rgb(&le32(), &data, 3, 2, 16).unwrap(), flat(&rows));
}

#[test]
fn twenty_four_bit_pixels_without_a_pad_byte_convert() {
    let mut format = le32();
    format.bits_per_pixel = 24;
    let data: Vec<u8> = COLOURS[..2]
        .iter()
        .flat_map(|[r, g, b]| [*b, *g, *r])
        .collect();
    assert_eq!(
        to_rgb(&format, &data, 2, 1, 6).unwrap(),
        flat(&COLOURS[..2])
    );
}

fn names_visual(format: &VisualFormat) {
    let error = to_rgb(format, &[0; 64], 2, 2, 8).unwrap_err();
    assert_eq!(error.code, agent_desktop_core::ErrorCode::ActionFailed);
    assert!(error.message.contains("not supported"), "{}", error.message);
    assert!(error.message.contains("depth"), "{}", error.message);
}

#[test]
fn sixteen_bit_pixels_are_refused_naming_the_visual() {
    let mut format = le32();
    format.bits_per_pixel = 16;
    format.depth = 16;
    names_visual(&format);
}

#[test]
fn a_visual_without_channel_masks_is_refused() {
    let mut format = le32();
    format.red_mask = 0;
    format.green_mask = 0;
    format.blue_mask = 0;
    names_visual(&format);
}

#[test]
fn ten_bit_channels_are_refused() {
    let mut format = le32();
    format.red_mask = 0x3ff0_0000;
    format.green_mask = 0x000f_fc00;
    format.blue_mask = 0x0000_03ff;
    format.depth = 30;
    names_visual(&format);
}

#[test]
fn rows_shorter_than_the_image_are_refused_not_read_past() {
    assert!(to_rgb(&le32(), &[0; 12], 2, 2, 8).is_err());
    assert!(to_rgb(&le32(), &[0; 64], 2, 2, 4).is_err());
}

#[test]
fn zero_size_is_refused() {
    assert!(to_rgb(&le32(), &[], 0, 2, 8).is_err());
    assert!(to_rgb(&le32(), &[], 2, 0, 8).is_err());
}
