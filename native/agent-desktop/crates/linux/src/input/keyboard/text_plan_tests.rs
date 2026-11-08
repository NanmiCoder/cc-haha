use super::*;

#[test]
fn text_under_a_changed_keyboard_group_or_modifiers_is_refused_before_planning() {
    for (group, modifiers) in [(0, 2), (1, 0), (0, 1), (0, 128)] {
        let mut map = Keymap::sample();
        map.group = group;
        map.modifiers = modifiers;
        let error =
            plan_text(&map, "aA!").expect_err("state-blind keycodes would type different text");
        assert_eq!(error.code, ErrorCode::ActionNotSupported);
        assert_eq!(error.disposition, DeliverySemantics::not_delivered());
        assert_eq!(error.details.unwrap()["physical_delivery_started"], false);
    }
    assert!(plan_text(&Keymap::sample(), "aA!").is_ok());
}

#[test]
fn mapped_text_controls_are_refused_before_dispatch() {
    let map = Keymap::new(8, 1, vec![0x61, 0x62, 0xff09, 0xff0d], 0, vec![]);
    for text in ["a\tb", "a\nb", "a\rb"] {
        let error = plan_text(&map, text).expect_err("controls can change the target");
        assert_eq!(error.code, ErrorCode::InvalidArgs);
        assert_eq!(error.disposition, DeliverySemantics::not_delivered());
        let details = error.details.unwrap();
        assert_eq!(details["physical_delivery_started"], false);
        assert_eq!(
            details["refused_character_classes"],
            serde_json::json!(["control"])
        );
    }
    assert!(plan_text(&map, "ab").is_ok());
}

#[test]
fn text_planning_safety() {
    let map = Keymap::sample();
    let plans = plan_text(&map, "aA!").unwrap();
    assert_eq!(plans.len(), 1);
    assert_eq!(
        plans[0].steps.get(1),
        Some(&Step::Key {
            code: 10,
            down: true
        })
    );
    assert_eq!(
        plans[0].steps.last(),
        Some(&Step::Key {
            code: 8,
            down: false
        })
    );
    assert!(plan_text(&map, "").unwrap().is_empty());

    let boundary = plan_text(&map, &"é".repeat(CHUNK_CHARS + 1)).unwrap();
    assert_eq!(boundary.len(), 2);
    assert_eq!(boundary[0].steps.len(), CHUNK_CHARS * 2 + 1);
    assert_eq!(boundary[1].steps.len(), 3);

    let remapped = plan_text(&map, "你你").unwrap();
    let edits: Vec<_> = remapped[0]
        .steps
        .iter()
        .filter_map(|step| match step {
            Step::Keymap(edit) => Some(edit),
            _ => None,
        })
        .collect();
    assert_eq!(edits.len(), 2);
    assert_eq!(edits[0].keycode, 14);
    assert_eq!(edits[0].keysyms, vec![0x0100_4f60; 4]);
    assert_eq!(edits[1].keysyms, vec![0; 4]);
    let key_up = remapped[0]
        .steps
        .iter()
        .rposition(|step| matches!(step, Step::Key { down: false, .. }))
        .unwrap();
    assert_eq!(
        remapped[0].steps[key_up + 1],
        Step::Pause(REMAP_RESTORE_HOLD)
    );

    let control = plan_text(&map, "a\u{7}").unwrap_err();
    assert_eq!(control.code, ErrorCode::InvalidArgs);
    assert_eq!(control.details.unwrap()["physical_delivery_started"], false);
    let no_spare = Keymap::new(
        8,
        2,
        vec![0x61, 0x41],
        2,
        vec![8, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0],
    );
    assert_eq!(
        plan_text(&no_spare, "你").unwrap_err().code,
        ErrorCode::ActionNotSupported
    );
    let no_shift = Keymap::new(8, 2, vec![0x61, 0x41], 0, Vec::new());
    assert_eq!(
        plan_text(&no_shift, "A").unwrap_err().code,
        ErrorCode::ActionNotSupported
    );
}

fn count(steps: &[Step], wanted: impl Fn(&Step) -> bool) -> usize {
    steps.iter().filter(|step| wanted(step)).count()
}

#[test]
fn spare_keys_keep_their_characters_across_chunks_and_are_restored_once_at_the_end() {
    let map = Keymap::sample();
    let plans = plan_text(&map, &"你".repeat(CHUNK_CHARS * 3)).unwrap();
    assert_eq!(plans.len(), 3);
    let edits = |plan: &Plan| count(&plan.steps, |step| matches!(step, Step::Keymap(_)));
    assert_eq!(edits(&plans[0]), 1);
    assert_eq!(edits(&plans[1]), 0);
    assert_eq!(edits(&plans[2]), 1);
    let restore = plans[2]
        .steps
        .iter()
        .position(|step| matches!(step, Step::Keymap(_)))
        .unwrap();
    assert_eq!(plans[2].steps[restore - 1], Step::Pause(REMAP_RESTORE_HOLD));
    let typed: usize = plans
        .iter()
        .map(|plan| {
            count(&plan.steps, |step| {
                matches!(step, Step::Key { down: true, .. })
            })
        })
        .sum();
    assert_eq!(typed, CHUNK_CHARS * 3);
}
