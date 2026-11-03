use std::collections::HashSet;
use std::time::Duration;

use agent_desktop_core::{AdapterError, DeliverySemantics, ErrorCode, Modifier};

use super::key_lookup::KeyLookup;
use super::key_names::keysym_for_char;
use super::keymap::Keymap;
use super::keymap_edit::KeymapEdit;
use super::keysym_step::KeysymStep;
use crate::input::plan::Plan;
use crate::input::step::Step;

pub(crate) const CHUNK_CHARS: usize = 32;
const REMAP_SETTLE: Duration = Duration::from_millis(50);
pub(crate) const REMAP_RESTORE_HOLD: Duration = Duration::from_millis(50);

#[derive(Clone, Copy)]
enum Typing {
    Mapped(KeyLookup),
    Unmapped(char),
}

struct Slot {
    keycode: u8,
    original: Vec<u32>,
}

struct Remap {
    slots: Vec<Slot>,
    width: usize,
}

pub(crate) const MAX_REMAP_SLOTS: usize = 32;

pub(crate) fn plan_text(map: &Keymap, text: &str) -> Result<Vec<Plan>, AdapterError> {
    if !text.is_empty() {
        map.ensure_text_state()?;
    }
    let controls: Vec<_> = text
        .chars()
        .filter(|character| character.is_control())
        .collect();
    if !controls.is_empty() {
        return Err(refusal(&controls));
    }
    let typings: Vec<Typing> = text.chars().map(|c| classify(map, c)).collect();
    let unmapped: Vec<char> = typings
        .iter()
        .filter_map(|typing| match typing {
            Typing::Unmapped(character) => Some(*character),
            Typing::Mapped(_) => None,
        })
        .collect();
    let remap = (!unmapped.is_empty())
        .then(|| remap_for(map, &unmapped))
        .transpose()?;
    let mut assignments = remap.as_ref().map(Assignments::new);
    let chunks: Vec<&[Typing]> = typings.chunks(CHUNK_CHARS).collect();
    let last = chunks.len().saturating_sub(1);
    chunks
        .into_iter()
        .enumerate()
        .map(|(index, chunk)| chunk_plan(map, chunk, assignments.as_mut(), index == last))
        .collect()
}

fn classify(map: &Keymap, character: char) -> Typing {
    let keysym = keysym_for_char(character);
    match map.lookup(keysym) {
        Some(lookup) => Typing::Mapped(lookup),
        None => Typing::Unmapped(character),
    }
}

fn remap_for(map: &Keymap, unmapped: &[char]) -> Result<Remap, AdapterError> {
    let distinct_count = unmapped
        .iter()
        .map(|character| keysym_for_char(*character))
        .collect::<HashSet<_>>()
        .len();
    let spare = map.spare_keycodes(distinct_count.min(MAX_REMAP_SLOTS));
    if spare.is_empty() {
        return Err(AdapterError::new(
            ErrorCode::ActionNotSupported,
            "The keyboard layout has no spare key to type characters it lacks",
        )
        .with_details(serde_json::json!({ "physical_delivery_started": false }))
        .with_disposition(DeliverySemantics::not_delivered()));
    }
    let slots = spare
        .into_iter()
        .map(|keycode| {
            map.keysyms_of(keycode)
                .map(|original| Slot { keycode, original })
                .ok_or_else(|| refusal(unmapped))
        })
        .collect::<Result<Vec<_>, _>>()?;
    Ok(Remap {
        slots,
        width: usize::from(map.keysyms_per_keycode),
    })
}

struct Assignments<'a> {
    remap: &'a Remap,
    holds: Vec<Option<u32>>,
    next: usize,
}

impl<'a> Assignments<'a> {
    fn new(remap: &'a Remap) -> Self {
        Self {
            remap,
            holds: vec![None; remap.slots.len()],
            next: 0,
        }
    }

    fn keycode_for(&mut self, steps: &mut Vec<Step>, keysym: u32) -> u8 {
        if let Some(index) = self.holds.iter().position(|held| *held == Some(keysym)) {
            return self.remap.slots[index].keycode;
        }
        let index = self.next;
        self.next = (self.next + 1) % self.remap.slots.len();
        if self.holds[index].is_some() {
            steps.push(Step::Pause(REMAP_RESTORE_HOLD));
        }
        let keycode = self.remap.slots[index].keycode;
        steps.push(Step::Keymap(KeymapEdit {
            keycode,
            keysyms: vec![keysym; self.remap.width],
        }));
        steps.push(Step::Pause(REMAP_SETTLE));
        self.holds[index] = Some(keysym);
        keycode
    }

    fn restore(&self, steps: &mut Vec<Step>) {
        steps.push(Step::Pause(REMAP_RESTORE_HOLD));
        for (index, held) in self.holds.iter().enumerate() {
            if held.is_some() {
                steps.push(Step::Keymap(KeymapEdit {
                    keycode: self.remap.slots[index].keycode,
                    keysyms: self.remap.slots[index].original.clone(),
                }));
            }
        }
    }
}

/// The characters the keyboard lacks keep their spare keys across chunks, so a
/// chunk boundary costs no keymap change: a client that is still refreshing
/// its keymap for one change is not handed the next one, and every spare key
/// is restored once, after the last character.
fn chunk_plan(
    map: &Keymap,
    chunk: &[Typing],
    mut assignments: Option<&mut Assignments<'_>>,
    last: bool,
) -> Result<Plan, AdapterError> {
    let shift = map.modifier_code(&Modifier::Shift);
    let mut steps = vec![Step::CheckTextState];
    for typing in chunk {
        match *typing {
            Typing::Mapped(lookup) => mapped_steps(&mut steps, lookup, shift)?,
            Typing::Unmapped(character) => {
                let Some(assignments) = assignments.as_deref_mut() else {
                    return Err(AdapterError::new(
                        ErrorCode::Internal,
                        "An unmapped character reached planning without a remap",
                    ));
                };
                let code = assignments.keycode_for(&mut steps, keysym_for_char(character));
                steps.push(Step::Key { code, down: true });
                steps.push(Step::Key { code, down: false });
            }
        }
    }
    if let Some(assignments) = assignments.filter(|a| last && a.holds.iter().any(Option::is_some)) {
        assignments.restore(&mut steps);
    }
    Ok(Plan {
        steps,
        release_origin: None,
    })
}

fn mapped_steps(
    steps: &mut Vec<Step>,
    lookup: KeyLookup,
    shift: Option<u8>,
) -> Result<(), AdapterError> {
    let wrapper = match (lookup.shift, shift) {
        (true, None) => {
            return Err(AdapterError::new(
                ErrorCode::ActionNotSupported,
                "The keyboard has no Shift key to type this text",
            )
            .with_details(serde_json::json!({ "physical_delivery_started": false }))
            .with_disposition(DeliverySemantics::not_delivered()));
        }
        (true, Some(code)) => Some(code),
        (false, _) => None,
    };
    if let Some(code) = wrapper {
        steps.push(Step::Key { code, down: true });
    }
    steps.push(Step::Key {
        code: lookup.code,
        down: true,
    });
    steps.push(Step::Key {
        code: lookup.code,
        down: false,
    });
    if let Some(code) = wrapper {
        steps.push(Step::Key { code, down: false });
    }
    Ok(())
}

fn refusal(unmapped: &[char]) -> AdapterError {
    let mut classes: Vec<_> = unmapped
        .iter()
        .map(|character| character_class(*character))
        .collect();
    classes.sort_unstable();
    classes.dedup();
    AdapterError::new(
        ErrorCode::InvalidArgs,
        "Text contains characters that cannot be sent safely as physical text",
    )
    .with_details(serde_json::json!({
        "physical_delivery_started": false,
        "refused_character_classes": classes,
        "refused_character_count": unmapped.len(),
    }))
    .with_suggestion(
        "Use headless 'type' or 'set-value' for literal text, or 'press' for navigation keys",
    )
    .with_disposition(DeliverySemantics::not_delivered())
}

fn character_class(character: char) -> &'static str {
    if character.is_control() {
        "control"
    } else if u32::from(character) < 0x250 {
        "latin_extended"
    } else if character.is_alphabetic() {
        "other_script_letter"
    } else {
        "symbol_or_emoji"
    }
}

pub(crate) fn plan_text_keysyms(text: &str) -> Vec<Vec<KeysymStep>> {
    let characters: Vec<char> = text.chars().collect();
    characters
        .chunks(CHUNK_CHARS)
        .map(|chunk| {
            chunk
                .iter()
                .flat_map(|character| {
                    let keysym = keysym_for_char(*character);
                    [
                        KeysymStep { keysym, down: true },
                        KeysymStep {
                            keysym,
                            down: false,
                        },
                    ]
                })
                .collect()
        })
        .collect()
}

#[cfg(test)]
#[path = "text_plan_tests.rs"]
mod tests;
