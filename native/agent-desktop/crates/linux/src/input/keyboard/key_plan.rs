use agent_desktop_core::{AdapterError, DeliverySemantics, ErrorCode, KeyCombo, Modifier};

use super::key_names::{keysym_for_key, modifier_keysym};
use super::keymap::Keymap;
use super::keysym_step::KeysymStep;
use crate::input::plan::Plan;
use crate::input::step::Step;

pub(crate) fn distinct_modifiers(modifiers: &[Modifier]) -> Vec<&Modifier> {
    let mut seen: Vec<&Modifier> = Vec::new();
    for modifier in modifiers {
        if !seen.contains(&modifier) {
            seen.push(modifier);
        }
    }
    seen
}

pub(crate) fn modifier_codes(
    map: &Keymap,
    modifiers: &[Modifier],
) -> Result<Vec<(Modifier, u8)>, AdapterError> {
    distinct_modifiers(modifiers)
        .into_iter()
        .map(|modifier| {
            map.modifier_code(modifier)
                .map(|code| (modifier.clone(), code))
                .ok_or_else(|| unmapped_modifier(modifier))
        })
        .collect()
}

fn unmapped_modifier(modifier: &Modifier) -> AdapterError {
    AdapterError::new(
        ErrorCode::ActionNotSupported,
        format!("The keyboard has no {modifier:?} modifier key"),
    )
    .with_details(serde_json::json!({ "physical_delivery_started": false }))
    .with_disposition(DeliverySemantics::not_delivered())
}

pub(crate) fn key_down_steps(codes: &[(Modifier, u8)]) -> Vec<Step> {
    codes
        .iter()
        .map(|(_, code)| Step::Key {
            code: *code,
            down: true,
        })
        .collect()
}

pub(crate) fn key_up_steps(codes: &[(Modifier, u8)]) -> Vec<Step> {
    codes
        .iter()
        .rev()
        .map(|(_, code)| Step::Key {
            code: *code,
            down: false,
        })
        .collect()
}

pub(crate) fn plan_combo(map: &Keymap, combo: &KeyCombo) -> Result<Plan, AdapterError> {
    let keysym = keysym_for_key(&combo.key)?;
    let lookup = map.lookup(keysym).ok_or_else(|| {
        AdapterError::new(
            ErrorCode::InvalidArgs,
            format!("Key '{}' is not on the active keyboard layout", combo.key),
        )
        .with_details(serde_json::json!({ "physical_delivery_started": false }))
        .with_disposition(DeliverySemantics::not_delivered())
    })?;
    let mut held = modifier_codes(map, &combo.modifiers)?;
    let shift_explicit = held
        .iter()
        .any(|(modifier, _)| *modifier == Modifier::Shift);
    if lookup.shift && !shift_explicit {
        let code = map
            .modifier_code(&Modifier::Shift)
            .ok_or_else(|| unmapped_modifier(&Modifier::Shift))?;
        held.push((Modifier::Shift, code));
    }
    let mut steps = key_down_steps(&held);
    steps.push(Step::Key {
        code: lookup.code,
        down: true,
    });
    steps.push(Step::Key {
        code: lookup.code,
        down: false,
    });
    steps.extend(key_up_steps(&held));
    Ok(Plan {
        steps,
        release_origin: None,
    })
}

pub(crate) fn plan_keysyms(combo: &KeyCombo) -> Result<Vec<KeysymStep>, AdapterError> {
    let keysym = keysym_for_key(&combo.key)?;
    let held: Vec<u32> = distinct_modifiers(&combo.modifiers)
        .into_iter()
        .map(modifier_keysym)
        .collect();
    let edge = |keysym: u32, down: bool| KeysymStep { keysym, down };
    let mut steps: Vec<KeysymStep> = held.iter().map(|held| edge(*held, true)).collect();
    steps.push(edge(keysym, true));
    steps.push(edge(keysym, false));
    steps.extend(held.iter().rev().map(|held| edge(*held, false)));
    Ok(steps)
}

#[cfg(test)]
#[path = "key_plan_tests.rs"]
mod tests;
