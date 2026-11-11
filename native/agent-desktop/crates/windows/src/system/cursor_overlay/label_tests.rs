use super::clamp;
use agent_desktop_core::MAX_CURSOR_LABEL_WORDS;

/// The ceiling the reading side applies, restated here so a change to it has
/// to be a deliberate one rather than a number these assertions follow.
const BYTE_CEILING: usize = 512;

/// A character wide enough that the byte ceiling lands inside one, which is
/// where cutting on the byte alone would split it.
const WIDE: &str = "日";

#[test]
fn an_ordinary_caption_is_left_alone() {
    assert_eq!(clamp("Opening the menu"), Some("Opening the menu".into()));
}

#[test]
fn a_caption_of_only_whitespace_says_nothing() {
    assert_eq!(clamp("   \t \n "), None);
}

/// The frame cap is 4096 bytes, so a sender that skips the configuration can
/// put a caption an order of magnitude past the card's ceiling on the wire.
///
/// One unbroken run rather than many words, because a caption of many words
/// would be bounded by the word ceiling on its own and the byte ceiling would
/// go unmeasured.
#[test]
fn a_caption_far_past_the_byte_ceiling_is_cut_down() {
    let shouted = "x".repeat(3_000);
    let clamped = clamp(&shouted).expect("a caption this long still says something");
    assert!(
        clamped.len() <= BYTE_CEILING,
        "the byte ceiling must bound what reaches the card, got {} bytes",
        clamped.len()
    );
}

/// Cutting on the byte alone would split a multi-byte character. The renderer
/// is being asked to shorten a caption, not to lose it.
#[test]
fn cutting_a_multibyte_caption_does_not_panic_or_split_a_character() {
    let wide = WIDE.repeat(1_000);
    let clamped = clamp(&wide).expect("a caption this long still says something");
    assert!(
        clamped.len() <= BYTE_CEILING,
        "the byte ceiling still applies, got {} bytes",
        clamped.len()
    );
    assert_eq!(
        clamped.chars().count() * WIDE.len(),
        clamped.len(),
        "every character must have survived whole: {clamped}"
    );
}

#[test]
fn a_caption_past_the_word_ceiling_is_cut_and_marked() {
    let many = (0..MAX_CURSOR_LABEL_WORDS + 5)
        .map(|index| format!("word{index}"))
        .collect::<Vec<_>>()
        .join(" ");
    let clamped = clamp(&many).expect("a caption this long still says something");
    assert!(clamped.ends_with('…'), "the cut must be marked: {clamped}");
    assert_eq!(
        clamped.split_whitespace().count(),
        MAX_CURSOR_LABEL_WORDS,
        "no more words than the card was designed to hold: {clamped}"
    );
}
