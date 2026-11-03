use super::*;

fn combo(key: &str, modifiers: &[Modifier]) -> KeyCombo {
    KeyCombo {
        key: key.into(),
        modifiers: modifiers.to_vec(),
    }
}

fn edges(steps: &[Step]) -> Vec<(u8, bool)> {
    steps
        .iter()
        .map(|step| match step {
            Step::Key { code, down } => (*code, *down),
            _ => unreachable!(),
        })
        .collect()
}

#[test]
fn combo_delivery_and_refusals() {
    let map = Keymap::sample();
    let plan = plan_combo(
        &map,
        &combo("a", &[Modifier::Ctrl, Modifier::Ctrl, Modifier::Shift]),
    )
    .unwrap();
    assert_eq!(
        edges(&plan.steps),
        [
            (9, true),
            (8, true),
            (10, true),
            (10, false),
            (8, false),
            (9, false)
        ]
    );
    let inferred = plan_combo(&map, &combo("A", &[])).unwrap();
    let explicit = plan_combo(&map, &combo("A", &[Modifier::Shift])).unwrap();
    assert_eq!(edges(&inferred.steps), edges(&explicit.steps));
    assert_eq!(
        edges(&inferred.steps)
            .iter()
            .filter(|(code, down)| *code == 8 && *down)
            .count(),
        1
    );
    assert_eq!(
        plan_combo(&map, &combo("你", &[])).unwrap_err().code,
        ErrorCode::InvalidArgs
    );
    let bare = Keymap::new(8, 2, vec![0x61, 0x41], 0, Vec::new());
    assert_eq!(
        plan_combo(&bare, &combo("a", &[Modifier::Ctrl]))
            .unwrap_err()
            .code,
        ErrorCode::ActionNotSupported
    );
    let steps = plan_keysyms(&combo(
        "a",
        &[Modifier::Ctrl, Modifier::Alt, Modifier::Ctrl],
    ))
    .unwrap();
    assert_eq!(
        steps.iter().map(|s| (s.keysym, s.down)).collect::<Vec<_>>(),
        [
            (0xffe3, true),
            (0xffe9, true),
            (0x61, true),
            (0x61, false),
            (0xffe9, false),
            (0xffe3, false)
        ]
    );
}
