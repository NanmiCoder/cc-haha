use accessibility_sys::{
    kAXErrorAPIDisabled, kAXErrorAttributeUnsupported, kAXErrorCannotComplete,
    kAXErrorInvalidUIElement, kAXErrorNoValue,
};

pub(crate) const ROLE: usize = 0;
pub(crate) const TITLE: usize = 1;
pub(crate) const DESCRIPTION: usize = 2;
pub(crate) const VALUE: usize = 3;
pub(crate) const ENABLED: usize = 4;
pub(crate) const FOCUSED: usize = 5;
pub(crate) const EXPANDED: usize = 6;
pub(crate) const DISCLOSING: usize = 7;
pub(crate) const SELECTED: usize = 8;
pub(crate) const HIDDEN: usize = 9;
pub(crate) const BUSY: usize = 10;
pub(crate) const MODAL: usize = 11;
pub(crate) const REQUIRED: usize = 12;
pub(crate) const AX_IDENTIFIER: usize = 13;
pub(crate) const AX_DOM_IDENTIFIER: usize = 14;
pub(crate) const LABEL: usize = 15;
pub(crate) const PLACEHOLDER: usize = 16;
pub(crate) const TITLE_ELEMENT: usize = 17;
pub(crate) const POSITION: usize = 18;
pub(crate) const SIZE: usize = 19;
pub(crate) const VERTICAL_SCROLLBAR: usize = 20;
pub(crate) const HORIZONTAL_SCROLLBAR: usize = 21;
pub(crate) const SUBROLE: usize = 22;
const READONLY_PROBE: usize = 23;
const ATTRIBUTE_COUNT: usize = 23;

const ROLE_MASK: u32 = bit(ROLE) | bit(SUBROLE);
const STATE_MASK: u32 =
    ROLE_MASK | bit(VALUE) | range_mask(4, 12) | bit(POSITION) | bit(SIZE) | bit(READONLY_PROBE);
const BOUNDS_MASK: u32 = bit(POSITION) | bit(SIZE);
const SCROLLBAR_MASK: u32 = bit(VERTICAL_SCROLLBAR) | bit(HORIZONTAL_SCROLLBAR);
const ALL_ATTRIBUTE_MASK: u32 = range_mask(0, ATTRIBUTE_COUNT - 1);

#[derive(Debug, Clone, Copy, Default)]
pub(crate) struct NodeAttributeStatus {
    unknown_mask: u32,
    pub(crate) cannot_complete: bool,
    pub(crate) native_read_failures: u64,
    pub(crate) invalid_element: bool,
    pub(crate) api_disabled: bool,
    pub(crate) text_truncations: u64,
}

impl NodeAttributeStatus {
    pub(crate) fn record_slot_error(&mut self, index: usize, error: i32) {
        self.record_error(bit(index), error);
    }

    pub(crate) fn record_native_slot_error(&mut self, index: usize, error: i32) {
        if !crate::tree::properties::ax_absence::is_absent_attribute_error(error) {
            self.record_slot_error(index, error);
        }
    }

    pub(crate) fn record_batch_error(&mut self, error: i32) {
        self.record_error(ALL_ATTRIBUTE_MASK, error);
    }

    pub(crate) fn record_readonly_error(&mut self, error: i32) {
        self.record_error(bit(READONLY_PROBE), error);
    }

    pub(crate) fn record_truncated(&mut self, index: usize) {
        self.unknown_mask |= bit(index);
        self.text_truncations += 1;
    }

    pub(crate) fn field_unknown(&self, index: usize) -> bool {
        self.unknown_mask & bit(index) != 0
    }

    pub(crate) fn role_unknown(&self) -> bool {
        self.unknown_mask & ROLE_MASK != 0
    }

    pub(crate) fn value_unknown(&self) -> bool {
        self.field_unknown(VALUE)
    }

    pub(crate) fn states_unknown(&self) -> bool {
        self.unknown_mask & STATE_MASK != 0
    }

    pub(crate) fn bounds_unknown(&self) -> bool {
        self.unknown_mask & BOUNDS_MASK != 0
    }

    pub(crate) fn scrollbars_unknown(&self) -> bool {
        self.unknown_mask & SCROLLBAR_MASK != 0
    }

    fn record_error(&mut self, mask: u32, error: i32) {
        if is_absent_error(error) {
            return;
        }
        self.unknown_mask |= mask;
        self.cannot_complete |= error == kAXErrorCannotComplete;
        self.invalid_element |= error == kAXErrorInvalidUIElement;
        self.api_disabled |= error == kAXErrorAPIDisabled;
        self.native_read_failures += u64::from(
            error != kAXErrorCannotComplete
                && error != kAXErrorInvalidUIElement
                && error != kAXErrorAPIDisabled,
        );
    }
}

pub(crate) const fn attribute_bit(index: usize) -> u32 {
    bit(index)
}

const fn bit(index: usize) -> u32 {
    1_u32 << index
}

const fn range_mask(start: usize, end: usize) -> u32 {
    ((1_u32 << (end + 1)) - 1) & !((1_u32 << start) - 1)
}

fn is_absent_error(error: i32) -> bool {
    error == kAXErrorAttributeUnsupported || error == kAXErrorNoValue
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn per_slot_errors_preserve_absent_unknown_and_terminal_states() {
        let fixtures = [
            (TITLE, kAXErrorAttributeUnsupported),
            (VALUE, kAXErrorCannotComplete),
            (AX_IDENTIFIER, kAXErrorInvalidUIElement),
            (AX_DOM_IDENTIFIER, kAXErrorAPIDisabled),
        ];
        let mut status = NodeAttributeStatus::default();
        for (index, error) in fixtures {
            status.record_slot_error(index, error);
        }

        assert!(!status.field_unknown(TITLE));
        assert!(status.field_unknown(VALUE));
        assert!(status.field_unknown(AX_IDENTIFIER));
        assert!(status.field_unknown(AX_DOM_IDENTIFIER));
        assert!(status.cannot_complete);
        assert!(status.invalid_element);
        assert!(status.api_disabled);
        assert_eq!(status.native_read_failures, 0);
    }

    #[test]
    fn unsupported_readonly_probe_does_not_make_state_unknown() {
        let mut status = NodeAttributeStatus::default();
        status.record_readonly_error(kAXErrorAttributeUnsupported);

        assert!(!status.states_unknown());
    }

    #[test]
    fn application_only_hidden_absence_differs_from_an_incomplete_hidden_read() {
        let mut absent = NodeAttributeStatus::default();
        absent.record_slot_error(HIDDEN, kAXErrorAttributeUnsupported);
        assert!(!absent.states_unknown());

        let mut incomplete = NodeAttributeStatus::default();
        incomplete.record_slot_error(HIDDEN, kAXErrorCannotComplete);
        assert!(incomplete.states_unknown());
        assert!(incomplete.cannot_complete);
    }

    #[test]
    fn truncated_text_is_unknown_instead_of_exact_evidence() {
        let mut status = NodeAttributeStatus::default();

        status.record_truncated(TITLE);

        assert!(status.field_unknown(TITLE));
        assert_eq!(status.text_truncations, 1);
    }

    #[test]
    fn native_absence_slots_do_not_make_name_evidence_unknown() {
        for error in [
            kAXErrorAttributeUnsupported,
            kAXErrorNoValue,
            accessibility_sys::kAXErrorNotImplemented,
            accessibility_sys::kAXErrorFailure,
        ] {
            let mut status = NodeAttributeStatus::default();
            status.record_native_slot_error(DESCRIPTION, error);

            assert!(!status.field_unknown(DESCRIPTION));
            assert_eq!(status.native_read_failures, 0);
        }
    }

    #[test]
    fn native_transport_and_invalid_element_slots_remain_unknown() {
        for error in [
            kAXErrorCannotComplete,
            kAXErrorInvalidUIElement,
            kAXErrorAPIDisabled,
        ] {
            let mut status = NodeAttributeStatus::default();
            status.record_native_slot_error(DESCRIPTION, error);

            assert!(status.field_unknown(DESCRIPTION));
            assert_eq!(status.cannot_complete, error == kAXErrorCannotComplete);
            assert_eq!(status.invalid_element, error == kAXErrorInvalidUIElement);
            assert_eq!(status.api_disabled, error == kAXErrorAPIDisabled);
        }
    }

    #[test]
    fn malformed_batches_cannot_be_treated_as_absence() {
        let mut status = NodeAttributeStatus::default();
        status.record_batch_error(accessibility_sys::kAXErrorFailure);

        assert!(status.field_unknown(DESCRIPTION));
        assert_eq!(status.native_read_failures, 1);
    }

    #[test]
    fn decode_failure_is_counted_as_an_unclassified_native_read_failure() {
        let mut status = NodeAttributeStatus::default();

        status.record_slot_error(ROLE, accessibility_sys::kAXErrorFailure);

        assert_eq!(status.native_read_failures, 1);
        assert!(status.role_unknown());
    }
}
