use agent_desktop_core::{AdapterError, DeliverySemantics, ErrorCode, Modifier};

use super::key_lookup::KeyLookup;

const SHIFT_ROW: usize = 0;
const CONTROL_ROW: usize = 2;
const ALT_ROW: usize = 3;
const SUPER_ROW: usize = 6;
const MODIFIER_ROWS: usize = 8;
const GROUP_ONE_LEVELS: usize = 2;
const NUM_LOCK: u32 = 0xff7f;
const SCROLL_LOCK: u32 = 0xff14;

#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub(crate) struct Keymap {
    pub(crate) min_keycode: u8,
    pub(crate) keysyms_per_keycode: u8,
    pub(crate) keysyms: Vec<u32>,
    pub(crate) modifier_codes_per_modifier: u8,
    pub(crate) modifier_codes: Vec<u8>,
    pub(crate) group: u8,
    pub(crate) modifiers: u16,
}

impl Keymap {
    /// Refuses a keyboard state under which the planned keycodes would type
    /// other text: a second layout group, a held modifier, or Caps Lock. Num
    /// Lock and Scroll Lock change no key the text plan uses, so the bits of
    /// the modifier rows whose keys carry only those two keysyms are harmless;
    /// a row that also holds another keysym keeps its bit, because that bit
    /// may stand for the other key.
    pub(crate) fn ensure_text_state(&self) -> Result<(), AdapterError> {
        if self.group == 0 && self.modifiers & !self.harmless_lock_bits() == 0 {
            return Ok(());
        }
        Err(AdapterError::new(
            ErrorCode::ActionNotSupported,
            "Physical text input requires the first keyboard group with no held modifier and Caps Lock off",
        )
        .with_details(serde_json::json!({ "check": "keyboard_state", "physical_delivery_started": false }))
        .with_suggestion("Release modifiers, turn off Caps Lock and select the first layout, or use headless type")
        .with_disposition(DeliverySemantics::not_delivered()))
    }

    fn harmless_lock_bits(&self) -> u16 {
        let width = usize::from(self.modifier_codes_per_modifier);
        (0..MODIFIER_ROWS)
            .filter(|row| {
                let codes: Vec<u8> = self
                    .modifier_codes
                    .get(row * width..(row + 1) * width)
                    .map(|codes| codes.iter().copied().filter(|code| *code != 0).collect())
                    .unwrap_or_default();
                !codes.is_empty()
                    && codes.iter().all(|code| {
                        self.keysyms_of(*code).is_some_and(|keysyms| {
                            keysyms.iter().any(|keysym| *keysym != 0)
                                && keysyms
                                    .iter()
                                    .all(|keysym| matches!(*keysym, 0 | NUM_LOCK | SCROLL_LOCK))
                        })
                    })
            })
            .fold(0, |bits, row| bits | (1 << row))
    }

    pub(crate) fn new(
        min_keycode: u8,
        keysyms_per_keycode: u8,
        keysyms: Vec<u32>,
        modifier_codes_per_modifier: u8,
        modifier_codes: Vec<u8>,
    ) -> Self {
        Self {
            min_keycode,
            keysyms_per_keycode,
            keysyms,
            modifier_codes_per_modifier,
            modifier_codes,
            group: 0,
            modifiers: 0,
        }
    }

    fn width(&self) -> usize {
        usize::from(self.keysyms_per_keycode)
    }

    fn keycode_count(&self) -> usize {
        match self.width() {
            0 => 0,
            width => self.keysyms.len() / width,
        }
    }

    fn code_at(&self, index: usize) -> Option<u8> {
        u8::try_from(index + usize::from(self.min_keycode)).ok()
    }

    fn column(&self, index: usize, level: usize) -> Option<u32> {
        if level >= self.width() {
            return None;
        }
        self.keysyms.get(index * self.width() + level).copied()
    }

    pub(crate) fn lookup(&self, keysym: u32) -> Option<KeyLookup> {
        if keysym == 0 {
            return None;
        }
        (0..GROUP_ONE_LEVELS).find_map(|level| {
            (0..self.keycode_count()).find_map(|index| {
                (self.column(index, level) == Some(keysym))
                    .then(|| self.code_at(index))
                    .flatten()
                    .map(|code| KeyLookup {
                        code,
                        shift: level == 1,
                    })
            })
        })
    }

    pub(crate) fn modifier_code(&self, modifier: &Modifier) -> Option<u8> {
        let row = match modifier {
            Modifier::Shift => SHIFT_ROW,
            Modifier::Ctrl => CONTROL_ROW,
            Modifier::Alt => ALT_ROW,
            Modifier::Meta => SUPER_ROW,
        };
        let width = usize::from(self.modifier_codes_per_modifier);
        self.modifier_codes
            .get(row * width..(row + 1) * width)?
            .iter()
            .copied()
            .find(|code| *code != 0)
    }

    pub(crate) fn spare_keycodes(&self, wanted: usize) -> Vec<u8> {
        (0..self.keycode_count())
            .rev()
            .filter(|index| (0..self.width()).all(|level| self.column(*index, level) == Some(0)))
            .filter_map(|index| self.code_at(index))
            .take(wanted)
            .collect()
    }

    pub(crate) fn keysyms_of(&self, keycode: u8) -> Option<Vec<u32>> {
        let width = self.width();
        if width == 0 {
            return None;
        }
        let start = usize::from(keycode).checked_sub(usize::from(self.min_keycode))? * width;
        self.keysyms.get(start..start + width).map(<[u32]>::to_vec)
    }
}

#[cfg(test)]
impl Keymap {
    pub(crate) fn sample() -> Self {
        #[rustfmt::skip]
        let keysyms = vec![
            0xffe1, 0,    0, 0,
            0xffe3, 0,    0, 0,
            0x61,   0x41, 0, 0,
            0x31,   0x21, 0, 0,
            0,      0,    0, 0,
            0xe9,   0xc9, 0, 0,
            0,      0,    0, 0,
        ];
        let mut modifier_codes = vec![0u8; 16];
        modifier_codes[0] = 8;
        modifier_codes[4] = 9;
        modifier_codes[7] = 12;
        modifier_codes[13] = 15;
        Self::new(8, 4, keysyms, 2, modifier_codes)
    }
}

#[cfg(test)]
#[path = "keymap_tests.rs"]
mod tests;
