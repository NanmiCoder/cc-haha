use super::utf16_range;

/// An all-ASCII field is where a byte cast and a scalar count still look
/// correct, so it pins the ordinary case the conversion must agree with.
#[test]
fn ascii_prefix_and_selection_offsets_equal_character_counts() {
    let range = utf16_range("hello", "world");

    assert_eq!(range, 5..10);
}

/// Each surrogate pair contributes two UTF-16 code units but one scalar, so a
/// scalar count falls behind by exactly one per pair.
#[test]
fn emoji_in_prefix_start_exceeds_character_count_by_one_per_pair() {
    let prefix = "\u{1F980}\u{1F980}";
    let range = utf16_range(prefix, "x");

    assert_eq!(range, 4..5);
    assert_eq!(range.start - prefix.chars().count(), 2);
    assert_eq!(prefix.chars().count(), 2);
}

/// The selected text's extent is counted the same way: two code units per
/// surrogate pair, so the range length is not the scalar count.
#[test]
fn emoji_in_selection_length_counts_two_per_pair() {
    let selection = "\u{1F980}a\u{1F980}";
    let range = utf16_range("", selection);

    assert_eq!(range, 0..5);
    assert_eq!(range.end - range.start, 5);
    assert_eq!(selection.chars().count(), 3);
}

/// A combining sequence is fewer grapheme clusters than scalars, and the
/// astral base here is fewer scalars than UTF-16 code units: the offsets must
/// follow UTF-16 units, which is neither of those smaller counts.
#[test]
fn combining_sequence_prefix_follows_utf16_units_not_graphemes() {
    let prefix = "e\u{0301}\u{1F980}";
    let range = utf16_range(prefix, "x");

    assert_eq!(range, 4..5);
    assert_eq!(prefix.encode_utf16().count(), 4);
    assert_ne!(range.start, prefix.chars().count());
    assert_eq!(prefix.chars().count(), 3);
}

/// An empty prefix places the start at zero, and an empty selection is an
/// empty range there rather than an absence.
#[test]
fn empty_prefix_starts_at_zero_and_empty_selection_is_empty_range() {
    let range = utf16_range("", "");

    assert_eq!(range, 0..0);
    assert!(range.is_empty());
}

/// One string where the byte length, the scalar count and the UTF-16 count are
/// all different: only the UTF-16 count may be produced.
#[test]
fn bytes_chars_and_utf16_all_differ_only_utf16_is_produced() {
    let prefix = "a\u{1F980}\u{e9}";

    assert_eq!(prefix.len(), 7);
    assert_eq!(prefix.chars().count(), 3);
    assert_eq!(prefix.encode_utf16().count(), 4);

    let range = utf16_range(prefix, "z");
    assert_eq!(range, 4..5);
}
