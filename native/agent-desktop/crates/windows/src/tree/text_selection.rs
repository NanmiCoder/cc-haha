//! The Text pattern selection read for `TypeText` verification.
//!
//! Core asks for the selected range in UTF-16 code units so it can predict what
//! a field should contain once typed text replaces the selection. UI Automation
//! text ranges do not promise UTF-16 indexing, so the offset is derived from
//! the text itself: the prefix range spans document-start to selection-start
//! and its UTF-16 length is the start offset, with the selected text's UTF-16
//! length giving the extent. No endpoint magnitude is compared numerically,
//! because a provider's comparison result is not a character count.

use std::ops::Range;

/// Maps the text before a selection and the selected text to a UTF-16
/// code-unit range.
///
/// `prefix` is the document text from the start of the document up to the
/// selection's start; `selection` is the selected text. Both counts are in
/// UTF-16 code units, deliberately not bytes or scalar values: a byte count
/// would over-count every non-ASCII scalar, a scalar count would under-count
/// every surrogate pair, and both would agree with the UTF-16 answer on an
/// all-ASCII field, which is exactly the shape that hides the defect.
fn utf16_range(prefix: &str, selection: &str) -> Range<usize> {
    let start = prefix.encode_utf16().count();
    start..start + selection.encode_utf16().count()
}

#[cfg(target_os = "windows")]
mod imp {
    use super::utf16_range;
    use crate::tree::element::uia_element;
    use agent_desktop_core::{AdapterError, Deadline, NativeHandle};
    use std::ops::Range;
    use uiautomation::patterns::UITextPattern;
    use uiautomation::types::TextPatternRangeEndpoint;

    /// Reads the element's current selection as UTF-16 code-unit offsets.
    ///
    /// Answers `Ok(None)` when the element exposes no Text pattern, when it has
    /// no selection, or when any read along the way fails: each is absent
    /// evidence, which core degrades to an unverified delivery rather than a
    /// failure. The prefix range is the document range with its end moved to
    /// the selection start, read once and mutated in place; no clone of a
    /// range whose provider may not implement one is needed.
    pub(crate) fn get_text_selection(
        handle: &NativeHandle,
        deadline: Deadline,
    ) -> Result<Option<Range<usize>>, AdapterError> {
        deadline.ensure_remaining()?;
        let element = uia_element(handle)?;
        let Ok(pattern) = element.0.get_pattern::<UITextPattern>() else {
            return Ok(None);
        };
        let Ok(selections) = pattern.get_selection() else {
            return Ok(None);
        };
        let Some(selection) = selections.into_iter().next() else {
            return Ok(None);
        };
        let Ok(prefix) = pattern.get_document_range() else {
            return Ok(None);
        };
        if prefix
            .move_endpoint_by_range(
                TextPatternRangeEndpoint::End,
                &selection,
                TextPatternRangeEndpoint::Start,
            )
            .is_err()
        {
            return Ok(None);
        }
        let (Ok(prefix_text), Ok(selection_text)) = (prefix.get_text(-1), selection.get_text(-1))
        else {
            return Ok(None);
        };
        Ok(Some(utf16_range(&prefix_text, &selection_text)))
    }
}

#[cfg(not(target_os = "windows"))]
mod imp {
    use agent_desktop_core::{AdapterError, Deadline, NativeHandle};
    use std::ops::Range;

    /// Canned twin so the crate compiles on a non-Windows lane; there is no
    /// live element there, so the selection is absent rather than invented.
    pub(crate) fn get_text_selection(
        _handle: &NativeHandle,
        _deadline: Deadline,
    ) -> Result<Option<Range<usize>>, AdapterError> {
        Ok(None)
    }
}

pub(crate) use imp::get_text_selection;

#[cfg(test)]
#[path = "text_selection_tests.rs"]
mod tests;
