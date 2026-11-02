/// The X keysym names of the printable ASCII characters that have no
/// single-character spelling a shell passes through safely, and the
/// punctuation names macOS and Windows accept for the same keys.
pub(in crate::input) const PUNCTUATION_NAMES: &[(&str, u32)] = &[
    ("exclam", 0x21),
    ("quotedbl", 0x22),
    ("numbersign", 0x23),
    ("dollar", 0x24),
    ("percent", 0x25),
    ("ampersand", 0x26),
    ("apostrophe", 0x27),
    ("quote", 0x27),
    ("parenleft", 0x28),
    ("parenright", 0x29),
    ("asterisk", 0x2a),
    ("plus", 0x2b),
    ("comma", 0x2c),
    ("minus", 0x2d),
    ("period", 0x2e),
    ("slash", 0x2f),
    ("colon", 0x3a),
    ("semicolon", 0x3b),
    ("less", 0x3c),
    ("equal", 0x3d),
    ("greater", 0x3e),
    ("question", 0x3f),
    ("at", 0x40),
    ("bracketleft", 0x5b),
    ("leftbracket", 0x5b),
    ("backslash", 0x5c),
    ("bracketright", 0x5d),
    ("rightbracket", 0x5d),
    ("asciicircum", 0x5e),
    ("underscore", 0x5f),
    ("grave", 0x60),
    ("braceleft", 0x7b),
    ("bar", 0x7c),
    ("braceright", 0x7d),
    ("asciitilde", 0x7e),
];

/// The X keysym names of the non-printing keys beyond the short names, and
/// the macOS `forwarddelete`.
pub(in crate::input) const KEY_NAMES: &[(&str, u32)] = &[
    ("forwarddelete", 0xffff),
    ("page_up", 0xff55),
    ("page_down", 0xff56),
    ("prior", 0xff55),
    ("next", 0xff56),
    ("kp_enter", 0xff8d),
    ("linefeed", 0xff0a),
    ("iso_left_tab", 0xfe20),
    ("caps_lock", 0xffe5),
    ("num_lock", 0xff7f),
    ("scroll_lock", 0xff14),
    ("print", 0xff61),
    ("pause", 0xff13),
    ("menu", 0xff67),
    ("shift_l", 0xffe1),
    ("shift_r", 0xffe2),
    ("control_l", 0xffe3),
    ("control_r", 0xffe4),
    ("alt_l", 0xffe9),
    ("alt_r", 0xffea),
    ("super_l", 0xffeb),
    ("super_r", 0xffec),
    ("win", 0xffeb),
];

pub(in crate::input) fn lookup(lowered: &str) -> Option<u32> {
    PUNCTUATION_NAMES
        .iter()
        .chain(KEY_NAMES)
        .find(|(known, _)| *known == lowered)
        .map(|(_, keysym)| *keysym)
}
