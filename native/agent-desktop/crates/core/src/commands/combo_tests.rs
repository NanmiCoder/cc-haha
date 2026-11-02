use super::{parse_combo, parse_combo_normalized};
use crate::Modifier;

#[test]
fn parse_combo_single_modifier_and_key() {
    let combo = parse_combo("cmd+k").expect("cmd+k is valid");
    assert_eq!(combo.key, "k");
    assert_eq!(combo.modifiers, vec![Modifier::Meta]);
}

#[test]
fn parse_combo_two_modifiers_preserved_in_declaration_order() {
    let combo = parse_combo("cmd+shift+t").expect("cmd+shift+t is valid");
    assert_eq!(combo.key, "t");
    assert_eq!(combo.modifiers, vec![Modifier::Meta, Modifier::Shift]);
}

#[test]
fn parse_combo_bare_key_yields_empty_modifier_list() {
    let combo = parse_combo("return").expect("bare key is valid");
    assert_eq!(combo.key, "return");
    assert!(combo.modifiers.is_empty());
}

#[test]
fn parse_combo_accepts_long_form_modifier_aliases() {
    let cmd = parse_combo("command+a").expect("command alias");
    assert_eq!(cmd.modifiers, vec![Modifier::Meta]);

    let meta = parse_combo("meta+a").expect("portable meta name");
    assert_eq!(meta.modifiers, vec![Modifier::Meta]);

    let alt = parse_combo("option+x").expect("option alias");
    assert_eq!(alt.modifiers, vec![Modifier::Alt]);

    let ctrl = parse_combo("control+y").expect("control alias");
    assert_eq!(ctrl.modifiers, vec![Modifier::Ctrl]);
}

#[test]
fn parse_combo_rejects_unknown_modifier_with_invalid_args_code() {
    let err = parse_combo("hyper+k").expect_err("unknown modifier must fail");
    assert_eq!(err.code(), "INVALID_ARGS");
    assert!(
        err.to_string().contains("hyper"),
        "error must name the unknown modifier, got: {}",
        err
    );
}

#[test]
fn parse_combo_rejects_empty_trailing_key() {
    let err = parse_combo("cmd+").expect_err("trailing + with no key must fail");
    assert_eq!(err.code(), "INVALID_ARGS");
}

#[test]
fn parse_combo_key_is_preserved_verbatim_without_lowercasing() {
    let combo = parse_combo("cmd+K").expect("uppercase key is valid after lowercase modifier");
    assert_eq!(
        combo.key, "K",
        "parse_combo must NOT lowercase the key — normalization is the caller's responsibility"
    );
    assert_eq!(combo.modifiers, vec![Modifier::Meta]);
}

#[test]
fn parse_combo_accepts_super_and_win_as_meta() {
    for raw in ["super+e", "win+e"] {
        let combo = parse_combo(raw).expect("platform name for the meta key");
        assert_eq!(combo.modifiers, vec![Modifier::Meta], "{raw}");
    }
}

#[test]
fn bare_uppercase_letter_means_the_shifted_key() {
    let combo = parse_combo_normalized("H").expect("H is valid");
    assert_eq!(combo.key, "h");
    assert_eq!(combo.modifiers, vec![Modifier::Shift]);
    let explicit = parse_combo_normalized("shift+H").expect("shift+H is valid");
    assert_eq!(explicit.modifiers, vec![Modifier::Shift]);
    let chord = parse_combo_normalized("Ctrl+A").expect("Ctrl+A is valid");
    assert_eq!(chord.key, "a");
    assert_eq!(chord.modifiers, vec![Modifier::Ctrl]);
    assert!(parse_combo_normalized("h").unwrap().modifiers.is_empty());
    assert!(
        parse_combo_normalized("Return")
            .unwrap()
            .modifiers
            .is_empty()
    );
}
