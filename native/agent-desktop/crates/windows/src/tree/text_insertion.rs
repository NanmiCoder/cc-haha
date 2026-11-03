//! Where a text element's insertion point sits on screen, read from its Text
//! pattern: the bounds of the character before the insertion point, or,
//! after a line break or in an empty field, the start of the line it opens.
//! A degenerate range has no bounds of its own, so the caret is placed from
//! its neighbour.

/// The caret for a line box `line`, `x` along it.
fn caret_at(x: f64, line: &agent_desktop_core::Rect) -> agent_desktop_core::Rect {
    agent_desktop_core::Rect {
        x,
        y: line.y,
        width: 2.0,
        height: line.height.max(10.0),
    }
}

fn is_line_break(text: &str) -> bool {
    matches!(text, "\r" | "\n" | "\r\n" | "\u{2028}" | "\u{2029}")
}

/// How many lines `text` ends, so a caret on an empty line, whose break a
/// provider reports no bounds for, can be placed that many lines below the
/// first: CR LF is one break, and so is a lone CR, LF or Unicode separator.
fn count_line_breaks(text: &str) -> u32 {
    let mut count = 0;
    let mut after_cr = false;
    for character in text.chars() {
        if !(character == '\n' && after_cr)
            && matches!(character, '\r' | '\n' | '\u{2028}' | '\u{2029}')
        {
            count += 1;
        }
        after_cr = character == '\r';
    }
    count
}

#[cfg(target_os = "windows")]
mod imp {
    use super::{caret_at, count_line_breaks, is_line_break};
    use crate::tree::element::uia_element;
    use agent_desktop_core::{AdapterError, Deadline, NativeHandle, ProcessId, Rect};
    use uiautomation::patterns::{UITextPattern, UITextRange};
    use uiautomation::types::{TextPatternRangeEndpoint, TextUnit};
    use uiautomation::variants::SafeArray;
    use windows::Win32::System::Variant::VT_R8;

    pub(crate) fn get_insertion_caret(
        handle: &NativeHandle,
        deadline: Deadline,
    ) -> Result<Option<Rect>, AdapterError> {
        deadline.ensure_remaining()?;
        let element = uia_element(handle)?;
        let Ok(pattern) = element.0.get_pattern::<UITextPattern>() else {
            return Ok(None);
        };
        Ok(caret(&pattern))
    }

    /// The insertion caret of the element with keyboard focus, when it belongs
    /// to `process` (or to any process, when `process` is `None`).
    pub(crate) fn get_focused_insertion_caret(
        process: Option<ProcessId>,
        deadline: Deadline,
    ) -> Result<Option<Rect>, AdapterError> {
        deadline.ensure_remaining()?;
        let client = crate::tree::automation::automation_client()?;
        let Ok(focused) = client.get_focused_element() else {
            return Ok(None);
        };
        if process.is_some_and(|process| {
            focused.get_process_id().ok().map(ProcessId::new) != Some(process)
        }) {
            return Ok(None);
        }
        let Ok(pattern) = focused.get_pattern::<UITextPattern>() else {
            return Ok(None);
        };
        Ok(caret(&pattern))
    }

    fn caret(pattern: &UITextPattern) -> Option<Rect> {
        let selection = pattern.get_selection().ok()?.into_iter().next()?;
        let previous = collapsed_at_end(pattern, &selection)?;
        let moved = previous
            .move_endpoint_by_unit(TextPatternRangeEndpoint::Start, TextUnit::Character, -1)
            .ok()?;
        if moved == 0 {
            let first = first_character(pattern)?;
            return Some(caret_at(first.x, &first));
        }
        let text = previous.get_text(-1).ok()?;
        let line = bounds(&previous);
        if !is_line_break(&text) {
            let line = line?;
            return Some(caret_at(line.x + line.width, &line));
        }
        let first = first_character(pattern);
        if let Some(line) = line {
            return Some(Rect {
                x: first.map_or(line.x, |first| first.x),
                y: line.y + line.height,
                width: 2.0,
                height: line.height.max(10.0),
            });
        }
        let first = first?;
        let breaks = count_line_breaks(&text_before(pattern, &selection)?);
        Some(Rect {
            x: first.x,
            y: first.y + f64::from(breaks) * first.height,
            width: 2.0,
            height: first.height.max(10.0),
        })
    }

    /// The document's text up to the insertion point.
    fn text_before(pattern: &UITextPattern, selection: &UITextRange) -> Option<String> {
        let range = pattern.get_document_range().ok()?;
        range
            .move_endpoint_by_range(
                TextPatternRangeEndpoint::End,
                selection,
                TextPatternRangeEndpoint::End,
            )
            .ok()?;
        range.get_text(-1).ok()
    }

    fn collapsed_at_end(pattern: &UITextPattern, selection: &UITextRange) -> Option<UITextRange> {
        let range = pattern.get_document_range().ok()?;
        range
            .move_endpoint_by_range(
                TextPatternRangeEndpoint::Start,
                selection,
                TextPatternRangeEndpoint::End,
            )
            .ok()?;
        range
            .move_endpoint_by_range(
                TextPatternRangeEndpoint::End,
                selection,
                TextPatternRangeEndpoint::End,
            )
            .ok()?;
        Some(range)
    }

    fn first_character(pattern: &UITextPattern) -> Option<Rect> {
        let range = pattern.get_document_range().ok()?;
        let document_start = pattern.get_document_range().ok()?;
        range
            .move_endpoint_by_range(
                TextPatternRangeEndpoint::End,
                &document_start,
                TextPatternRangeEndpoint::Start,
            )
            .ok()?;
        range
            .move_endpoint_by_unit(TextPatternRangeEndpoint::End, TextUnit::Character, 1)
            .ok()?;
        bounds(&range)
    }

    /// The first line box of a range, from its bounding rectangles: x, y,
    /// width and height quadruples in screen pixels.
    fn bounds(range: &UITextRange) -> Option<Rect> {
        let raw = unsafe { range.as_ref().GetBoundingRectangles() }.ok()?;
        let values: Vec<f64> = SafeArray::from(raw).into_vector(VT_R8).ok()?;
        let [x, y, width, height] = values.get(..4)? else {
            return None;
        };
        (*height > 0.0).then_some(Rect {
            x: *x,
            y: *y,
            width: *width,
            height: *height,
        })
    }
}

#[cfg(not(target_os = "windows"))]
mod imp {
    use agent_desktop_core::{AdapterError, Deadline, NativeHandle, Rect};

    pub(crate) fn get_insertion_caret(
        _handle: &NativeHandle,
        _deadline: Deadline,
    ) -> Result<Option<Rect>, AdapterError> {
        Ok(None)
    }

    pub(crate) fn get_focused_insertion_caret(
        _process: Option<agent_desktop_core::ProcessId>,
        _deadline: Deadline,
    ) -> Result<Option<Rect>, AdapterError> {
        Err(AdapterError::not_supported("get_focused_insertion_caret"))
    }
}

pub(crate) use imp::{get_focused_insertion_caret, get_insertion_caret};

#[cfg(test)]
#[path = "text_insertion_tests.rs"]
mod tests;
