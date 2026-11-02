use super::*;

fn bytes_of(values: &[u32]) -> Vec<u8> {
    values
        .iter()
        .flat_map(|value| value.to_ne_bytes())
        .collect()
}

#[test]
fn a_client_list_of_three_window_ids_decodes_to_three_ids() {
    let decoded = decode_cardinals(32, &bytes_of(&[0x0040_0003, 0x0060_0001, 7]));
    assert_eq!(decoded, Some(vec![0x0040_0003, 0x0060_0001, 7]));
}

#[test]
fn a_truncated_client_list_is_rejected_not_read_short() {
    let mut bytes = bytes_of(&[1, 2, 3]);
    bytes.pop();
    assert_eq!(decode_cardinals(32, &bytes), None);
}

#[test]
fn a_property_that_is_not_32_bit_is_rejected() {
    assert_eq!(decode_cardinals(8, &bytes_of(&[1])), None);
}

#[test]
fn an_empty_client_list_is_an_empty_list_not_a_failure() {
    assert_eq!(decode_cardinals(32, &[]), Some(Vec::new()));
}

#[test]
fn frame_extents_with_the_wrong_number_of_fields_are_rejected() {
    assert_eq!(decode_frame_extents(32, &bytes_of(&[1, 2, 3])), None);
}

#[test]
fn a_utf8_title_and_a_latin1_fallback_decode_to_the_same_text() {
    let utf8 = "Caf\u{e9}".as_bytes();
    let latin1 = [b'C', b'a', b'f', 0xe9];
    assert_eq!(decode_title(Some((8, utf8)), None), "Caf\u{e9}");
    assert_eq!(decode_title(None, Some((8, &latin1))), "Caf\u{e9}");
}

#[test]
fn an_empty_utf8_title_falls_back_to_the_latin1_one() {
    assert_eq!(decode_title(Some((8, b"")), Some((8, b"plain"))), "plain");
}

#[test]
fn an_invalid_utf8_title_is_replaced_never_an_error() {
    let title = decode_title(Some((8, &[b'a', 0xff, b'b'])), None);
    assert_eq!(title, "a\u{fffd}b");
}

#[test]
fn no_title_at_all_is_an_empty_title() {
    assert_eq!(decode_title(None, None), "");
}
