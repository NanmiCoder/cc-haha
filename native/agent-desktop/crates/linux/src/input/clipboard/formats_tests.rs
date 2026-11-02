use super::*;

fn names(targets: &[Target]) -> Vec<&str> {
    targets.iter().map(|target| target.name.as_str()).collect()
}

#[test]
fn text_within_latin1_serves_all_four_targets() {
    let targets = encode_text_targets("café");
    assert_eq!(
        names(&targets),
        [UTF8_STRING, TEXT_UTF8, TEXT_PLAIN, STRING]
    );
    assert_eq!(targets[3].bytes, [0x63, 0x61, 0x66, 0xe9]);
    assert_eq!(targets[0].bytes, "café".as_bytes());
}

#[test]
fn a_character_above_u00ff_omits_the_string_target() {
    let targets = encode_text_targets("snow ☃");
    assert_eq!(names(&targets), [UTF8_STRING, TEXT_UTF8, TEXT_PLAIN]);
}
