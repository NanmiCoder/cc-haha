use super::*;

fn blocked(key: &str, modifiers: &[Modifier]) -> bool {
    is_blocked(&KeyCombo {
        key: key.to_string(),
        modifiers: modifiers.to_vec(),
    })
}

#[test]
fn blocked_shortcuts_and_nonblocked_controls() {
    for (key, modifiers) in [
        ("f4", vec![Modifier::Alt, Modifier::Shift]),
        ("TAB", vec![Modifier::Alt]),
        ("L", vec![Modifier::Meta]),
        ("d", vec![Modifier::Meta, Modifier::Shift]),
        ("Delete", vec![Modifier::Alt, Modifier::Ctrl]),
        ("forwarddelete", vec![Modifier::Ctrl, Modifier::Alt]),
        ("F12", vec![Modifier::Ctrl, Modifier::Alt]),
        ("meta", vec![]),
        ("win", vec![]),
        ("super", vec![Modifier::Alt]),
    ] {
        assert!(blocked(key, &modifiers), "{key} {modifiers:?}");
    }
    for (key, modifiers) in [
        ("f13", vec![Modifier::Ctrl, Modifier::Alt]),
        ("f4", vec![Modifier::Ctrl]),
        ("delete", vec![Modifier::Ctrl]),
        ("tab", vec![Modifier::Ctrl]),
        ("a", vec![Modifier::Ctrl]),
        ("hyper", vec![Modifier::Alt]),
    ] {
        assert!(!blocked(key, &modifiers), "{key} {modifiers:?}");
    }
}
