use super::*;

fn lookup(map: &Keymap, keysym: u32) -> Option<(u8, bool)> {
    map.lookup(keysym).map(|entry| (entry.code, entry.shift))
}

#[test]
fn lookup_layout_boundaries() {
    let map = Keymap::sample();
    assert_eq!(lookup(&map, 0x61), Some((10, false)));
    assert_eq!(lookup(&map, 0x41), Some((10, true)));
    assert_eq!(lookup(&map, 0x21), Some((11, true)));
    assert_eq!(lookup(&map, 0), None);
    assert_eq!(lookup(&map, 0x4f60), None);
    assert_eq!(
        lookup(
            &Keymap::new(8, 2, vec![0x30, 0x41, 0x41, 0x42], 0, vec![]),
            0x41
        ),
        Some((9, false))
    );
    assert_eq!(
        lookup(
            &Keymap::new(8, 4, vec![0x61, 0x41, 0x3b1, 0x391], 0, vec![]),
            0x3b1
        ),
        None
    );
    let ragged = Keymap::new(8, 2, vec![0x61, 0x41, 0x62], 0, vec![]);
    assert_eq!(lookup(&ragged, 0x62), None);
    assert_eq!(ragged.keysyms_of(9), None);
    assert_eq!(Keymap::new(8, 0, vec![1], 0, vec![]).keysyms_of(8), None);
    let modifiers = Keymap::new(
        8,
        1,
        vec![1],
        2,
        vec![0, 8, 0, 0, 0, 9, 0, 12, 0, 0, 0, 0, 0, 15, 0, 0],
    );
    for (modifier, code) in [
        (Modifier::Shift, 8),
        (Modifier::Ctrl, 9),
        (Modifier::Alt, 12),
        (Modifier::Meta, 15),
    ] {
        assert_eq!(modifiers.modifier_code(&modifier), Some(code));
    }
}

#[test]
fn spare_rows_are_bounded() {
    let map = Keymap::sample();
    assert_eq!(map.spare_keycodes(1), [14]);
    assert_eq!(map.spare_keycodes(5), [14, 12]);
    assert_eq!(map.keysyms_of(14), Some(vec![0; 4]));
    let full = Keymap::new(8, 2, vec![1, 2, 3, 4], 0, vec![]);
    assert!(full.spare_keycodes(1).is_empty());
    assert_eq!(full.keysyms_of(9), Some(vec![3, 4]));
    assert_eq!(full.keysyms_of(200), None);
    assert_eq!(full.keysyms_of(3), None);
}

#[test]
fn num_lock_and_scroll_lock_bits_are_harmless_and_caps_lock_is_not() {
    #[rustfmt::skip]
    let keysyms = vec![
        0x61,   0x41,
        0xff7f, 0,
        0xff14, 0,
        0xffe5, 0,
        0xff7f, 0xff7e,
    ];
    let mut modifier_codes = vec![0u8; 8];
    modifier_codes[1] = 11;
    modifier_codes[4] = 9;
    modifier_codes[5] = 10;
    modifier_codes[7] = 12;
    let mut map = Keymap::new(8, 2, keysyms, 1, modifier_codes);
    assert_eq!(map.harmless_lock_bits(), 0b0011_0000);
    for modifiers in [0, 0x10, 0x20, 0x30] {
        map.modifiers = modifiers;
        assert!(map.ensure_text_state().is_ok(), "modifiers {modifiers:#x}");
    }
    for modifiers in [0x2, 0x12, 0x1, 0x80] {
        map.modifiers = modifiers;
        let error = map
            .ensure_text_state()
            .expect_err("the keys would type other text");
        assert_eq!(error.code, ErrorCode::ActionNotSupported);
        assert_eq!(error.details.unwrap()["check"], "keyboard_state");
    }
    map.modifiers = 0x10;
    map.group = 1;
    assert!(map.ensure_text_state().is_err());
    assert_eq!(Keymap::sample().harmless_lock_bits(), 0);
}
