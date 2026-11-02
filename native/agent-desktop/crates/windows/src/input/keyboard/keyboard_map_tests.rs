use super::*;

/// The virtual key a name resolves to, dropping the layout modifiers the
/// scan-decoding tests below assert separately.
fn key_name_to_vk(key: &str) -> Result<u16, AdapterError> {
    resolve_key(key).map(|resolved| resolved.vk)
}

/// Every key name `crates/macos/src/input/keyboard/keyboard_map.rs::key_name_to_code`
/// accepts, transcribed as data. A silently-narrower Windows vocabulary must
/// fail this test rather than ship: the name *resolves* on both
/// platforms even though the combo it forms does not mean the same thing.
const MACOS_KEY_VOCABULARY: &[&str] = &[
    "a",
    "b",
    "c",
    "d",
    "e",
    "f",
    "g",
    "h",
    "i",
    "j",
    "k",
    "l",
    "m",
    "n",
    "o",
    "p",
    "q",
    "r",
    "s",
    "t",
    "u",
    "v",
    "w",
    "x",
    "y",
    "z",
    "0",
    "1",
    "2",
    "3",
    "4",
    "5",
    "6",
    "7",
    "8",
    "9",
    "return",
    "enter",
    "escape",
    "esc",
    "tab",
    "space",
    "delete",
    "backspace",
    "forwarddelete",
    "home",
    "end",
    "pageup",
    "pagedown",
    "left",
    "right",
    "down",
    "up",
    "cmd",
    "command",
    "shift",
    "alt",
    "option",
    "ctrl",
    "control",
    "f1",
    "f2",
    "f3",
    "f4",
    "f5",
    "f6",
    "f7",
    "f8",
    "f9",
    "f10",
    "f11",
    "f12",
];

#[test]
fn every_macos_key_name_resolves_on_windows() {
    let unmapped: Vec<&str> = MACOS_KEY_VOCABULARY
        .iter()
        .copied()
        .filter(|name| key_name_to_vk(name).is_err())
        .collect();

    assert!(
        unmapped.is_empty(),
        "Windows must resolve every macOS key name; unmapped: {unmapped:?}"
    );
}

#[test]
fn named_key_aliases_resolve_to_same_code() {
    assert_eq!(key_name_to_vk("return").unwrap(), VK_RETURN);
    assert_eq!(key_name_to_vk("enter").unwrap(), VK_RETURN);
    assert_eq!(key_name_to_vk("escape").unwrap(), VK_ESCAPE);
    assert_eq!(key_name_to_vk("esc").unwrap(), VK_ESCAPE);
    assert_eq!(key_name_to_vk("alt").unwrap(), VK_MENU);
    assert_eq!(key_name_to_vk("option").unwrap(), VK_MENU);
    assert_eq!(key_name_to_vk("cmd").unwrap(), VK_LWIN);
    assert_eq!(key_name_to_vk("command").unwrap(), VK_LWIN);
    assert_eq!(key_name_to_vk("ctrl").unwrap(), VK_CONTROL);
    assert_eq!(key_name_to_vk("control").unwrap(), VK_CONTROL);
}

#[test]
fn delete_and_backspace_map_to_the_backspace_key_not_forward_delete() {
    assert_eq!(key_name_to_vk("delete").unwrap(), VK_BACK);
    assert_eq!(key_name_to_vk("backspace").unwrap(), VK_BACK);
    assert_eq!(key_name_to_vk("forwarddelete").unwrap(), VK_DELETE);
    assert_ne!(VK_BACK, VK_DELETE);
}

#[test]
fn navigation_and_function_keys_map_to_expected_codes() {
    assert_eq!(key_name_to_vk("f1").unwrap(), 0x70);
    assert_eq!(key_name_to_vk("f12").unwrap(), 0x7B);
    assert_eq!(key_name_to_vk("tab").unwrap(), VK_TAB);
    assert_eq!(key_name_to_vk("left").unwrap(), VK_LEFT);
    assert_eq!(key_name_to_vk("up").unwrap(), VK_UP);
}

/// The scan's low byte equals the ASCII value on this layout, so this case
/// passes whether or not the shift state was read at all. It pins the
/// coincidence rather than the behaviour; the scan-decoding tests below are
/// the ones that can see the difference.
#[test]
fn digits_resolve_to_their_ascii_derived_virtual_key_on_a_us_layout() {
    for digit in '0'..='9' {
        let name = digit.to_string();
        assert_eq!(
            key_name_to_vk(&name).unwrap(),
            digit as u16,
            "digit VK codes are numerically identical to their ASCII value"
        );
    }
}

#[test]
fn unknown_key_name_returns_invalid_args_error_with_suggestion() {
    let error = key_name_to_vk("hyperkey").unwrap_err();

    assert_eq!(error.code, ErrorCode::InvalidArgs);
    assert!(error.message.contains("hyperkey"));
    assert!(error.suggestion.is_some());
}

#[test]
fn multi_character_unnamed_strings_are_rejected_not_silently_truncated() {
    let error = key_name_to_vk("ab").unwrap_err();

    assert_eq!(error.code, ErrorCode::InvalidArgs);
}

#[test]
fn uppercase_letter_names_are_not_accepted_the_vocabulary_is_lowercase() {
    assert!(key_name_to_vk("A").is_err());
}

/// `VkKeyScanW` packs the virtual key in the low byte and the modifiers the
/// layout needs in the high byte. These drive the decoder with synthetic scan
/// results because the mapping is pure and this rig has a US layout, where the
/// shift-requiring cases do not arise - the honest way to cover a case the
/// hardware cannot present.
#[test]
fn a_scan_requiring_shift_carries_shift_as_a_layout_modifier() {
    let resolved = resolved_from_scan(0x0135);

    assert_eq!(resolved.vk, 0x35, "the virtual key is still the low byte");
    assert!(resolved.layout_shift);
    assert!(!resolved.layout_control);
    assert!(!resolved.layout_alt);
    assert_eq!(resolved.layout_modifier_vks(), vec![VK_SHIFT]);
}

#[test]
fn a_scan_requiring_nothing_carries_no_layout_modifier() {
    let resolved = resolved_from_scan(0x0041);

    assert_eq!(resolved.vk, 0x41);
    assert!(!resolved.layout_shift);
    assert!(resolved.layout_modifier_vks().is_empty());
}

#[test]
fn a_scan_requiring_control_and_alt_carries_both() {
    let resolved = resolved_from_scan(0x0651);

    assert!(!resolved.layout_shift);
    assert!(resolved.layout_control);
    assert!(resolved.layout_alt);
    assert_eq!(resolved.layout_modifier_vks(), vec![VK_CONTROL, VK_MENU]);
}

/// A named key is produced by its virtual key alone, so it carries no layout
/// requirement - the case that keeps `layout_modifier_vks` from being read as
/// "always empty" by a reader who has only seen the scan tests above.
#[test]
fn a_named_key_carries_no_layout_modifier() {
    let resolved = resolve_key("return").expect("'return' resolves");

    assert_eq!(resolved.vk, VK_RETURN);
    assert!(resolved.layout_modifier_vks().is_empty());
}
