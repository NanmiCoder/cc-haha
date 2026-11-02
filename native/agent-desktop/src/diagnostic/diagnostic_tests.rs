use super::*;

#[test]
fn bounded_text_truncates_on_character_boundaries() {
    let output = bounded_text("aé日z", 3);

    assert!(output.starts_with("aé日…"));
    assert!(output.contains("7 bytes total"));
}

#[test]
fn token_labels_show_only_small_identifier_shaped_values() {
    assert_eq!(token_label("set-value"), "'set-value'");
    assert_eq!(token_label("secret value"), "token of 12 bytes");
    assert_eq!(token_label(&"x".repeat(65)), "token of 65 bytes");
}
