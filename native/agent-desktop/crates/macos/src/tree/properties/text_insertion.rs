//! Where a text element's insertion point sits on screen, read from the text
//! system rather than inferred from the element's bounds: the bounds of the
//! character before the insertion point, or, after a line break or in an
//! empty field, the start of the line it opens.
//!
//! A new line can start indented, as a list item or a checklist row does, and
//! at the end of the text the text system reports that empty line's position
//! without its indent. The caret then lines up with the text of the paragraph
//! above, and shows nowhere rather than at a guess when that paragraph is empty.

const CARET_WIDTH: f64 = 2.0;
const MIN_CARET_HEIGHT: f64 = 10.0;
/// How far back to look for the start of the paragraph above, in UTF-16 units.
const PARAGRAPH_WINDOW: usize = 4096;

fn caret(x: f64, line: &agent_desktop_core::Rect) -> agent_desktop_core::Rect {
    agent_desktop_core::Rect {
        x,
        y: line.y,
        width: CARET_WIDTH,
        height: line.height.max(MIN_CARET_HEIGHT),
    }
}

/// Where the paragraph that ends just before `text` starts, as a UTF-16
/// offset into `text`, which runs up to (not including) that paragraph's line
/// break; `None` when the paragraph is empty. With no line break in `text`,
/// the paragraph is taken to start at its beginning.
fn paragraph_start(text: &str) -> Option<usize> {
    let units: Vec<u16> = text.encode_utf16().collect();
    let start = units
        .iter()
        .rposition(|&unit| unit == u16::from(b'\n'))
        .map_or(0, |at| at + 1);
    (start < units.len()).then_some(start)
}

/// The caret on a line just opened by a line break. `next` is the character at
/// the insertion point, which only exists when text follows; `first` is the
/// first character of the paragraph above, `last` its last character, and
/// `insertion` the text system's own rectangle for the empty insertion point.
fn new_line_caret(
    next: Option<agent_desktop_core::Rect>,
    first: Option<agent_desktop_core::Rect>,
    last: Option<agent_desktop_core::Rect>,
    insertion: Option<agent_desktop_core::Rect>,
) -> Option<agent_desktop_core::Rect> {
    if let Some(next) = next {
        return Some(caret(next.x, &next));
    }
    let (first, last) = (first?, last?);
    let line = insertion
        .filter(|insertion| insertion.y >= last.y + last.height * 0.5)
        .unwrap_or(agent_desktop_core::Rect {
            y: last.y + last.height,
            ..last
        });
    Some(caret(first.x, &line))
}

#[cfg(target_os = "macos")]
mod imp {
    use super::{PARAGRAPH_WINDOW, caret, new_line_caret, paragraph_start};
    use crate::tree::AXElement;
    use agent_desktop_core::{AdapterError, Deadline, ErrorCode, Rect};

    /// The insertion caret of the element with keyboard focus in `pid`, or in
    /// the focused app when `pid` is `None`.
    pub(crate) fn focused_insertion_caret(
        pid: Option<i32>,
        deadline: Deadline,
    ) -> Result<Option<Rect>, AdapterError> {
        let owner = match pid {
            Some(pid) => crate::tree::element_for_pid(pid),
            None => AXElement(unsafe { accessibility_sys::AXUIElementCreateSystemWide() }),
        };
        let focused = super::super::attributes::copy_element_attr_result(
            &owner,
            "AXFocusedUIElement",
            deadline,
        )
        .map_err(|error| {
            AdapterError::new(
                ErrorCode::ActionFailed,
                "Could not read the focused element",
            )
            .with_details(serde_json::json!({ "ax_error": error }))
        })?;
        Ok(focused.and_then(|focused| insertion_caret(&focused, deadline)))
    }

    pub(crate) fn insertion_caret(element: &AXElement, deadline: Deadline) -> Option<Rect> {
        let selection = super::super::attributes::selected_text_range(element, deadline)?;
        let at = selection.end;
        if at == 0 {
            return bounds_for_range(element, 0, 1, deadline)
                .or_else(|| bounds_for_range(element, 0, 0, deadline))
                .map(|first| caret(first.x, &first));
        }
        let previous = bounds_for_range(element, at - 1, 1, deadline)?;
        if string_for_range(element, at - 1, 1, deadline).as_deref() != Some("\n") {
            return Some(caret(previous.x + previous.width, &previous));
        }
        let window = (at - 1).min(PARAGRAPH_WINDOW);
        let before = at - 1 - window;
        let (first, last) = match string_for_range(element, before, window, deadline) {
            Some(text) => match paragraph_start(&text) {
                Some(start) => (
                    bounds_for_range(element, before + start, 1, deadline),
                    bounds_for_range(element, at - 2, 1, deadline),
                ),
                None => (None, None),
            },
            None => (
                bounds_for_range(element, 0, 1, deadline).or(Some(previous)),
                Some(previous),
            ),
        };
        new_line_caret(
            bounds_for_range(element, at, 1, deadline),
            first,
            last,
            bounds_for_range(element, at, 0, deadline),
        )
    }

    fn bounds_for_range(
        element: &AXElement,
        location: usize,
        length: usize,
        deadline: Deadline,
    ) -> Option<Rect> {
        use accessibility_sys::{AXValueGetValue, kAXValueTypeCGRect};
        use core_graphics::geometry::CGRect;

        let raw = copy_for_range(element, "AXBoundsForRange", location, length, deadline)?;
        let mut rect = CGRect::new(
            &core_graphics::geometry::CGPoint::new(0.0, 0.0),
            &core_graphics::geometry::CGSize::new(0.0, 0.0),
        );
        let decoded = unsafe {
            AXValueGetValue(
                raw.as_CFTypeRef() as _,
                kAXValueTypeCGRect,
                (&mut rect as *mut CGRect).cast(),
            )
        };
        (decoded && rect.size.height > 0.0).then_some(Rect {
            x: rect.origin.x,
            y: rect.origin.y,
            width: rect.size.width,
            height: rect.size.height,
        })
    }

    fn string_for_range(
        element: &AXElement,
        location: usize,
        length: usize,
        deadline: Deadline,
    ) -> Option<String> {
        use core_foundation::string::CFString;

        let raw = copy_for_range(element, "AXStringForRange", location, length, deadline)?;
        raw.downcast::<CFString>().map(|text| text.to_string())
    }

    use core_foundation::base::TCFType;

    fn copy_for_range(
        element: &AXElement,
        attribute: &str,
        location: usize,
        length: usize,
        deadline: Deadline,
    ) -> Option<core_foundation::base::CFType> {
        use accessibility_sys::{AXValueCreate, kAXErrorSuccess, kAXValueTypeCFRange};
        use core_foundation::{base::CFType, string::CFString};
        use core_foundation_sys::base::CFRange;

        let range = CFRange {
            location: isize::try_from(location).ok()?,
            length: isize::try_from(length).ok()?,
        };
        let parameter =
            unsafe { AXValueCreate(kAXValueTypeCFRange, (&range as *const CFRange).cast()) };
        if parameter.is_null() {
            return None;
        }
        let parameter = unsafe { CFType::wrap_under_create_rule(parameter as _) };
        let attribute = CFString::new(attribute);
        let (error, raw) = super::super::ax_ipc::copy_parameterized_attribute_value(
            element,
            attribute.as_concrete_TypeRef(),
            parameter.as_CFTypeRef(),
            deadline,
        );
        if raw.is_null() {
            return None;
        }
        let value = unsafe { CFType::wrap_under_create_rule(raw) };
        (error == kAXErrorSuccess).then_some(value)
    }
}

#[cfg(not(target_os = "macos"))]
mod imp {
    use crate::tree::AXElement;
    use agent_desktop_core::{AdapterError, Deadline, Rect};

    pub(crate) fn insertion_caret(_element: &AXElement, _deadline: Deadline) -> Option<Rect> {
        None
    }

    pub(crate) fn focused_insertion_caret(
        _pid: Option<i32>,
        _deadline: Deadline,
    ) -> Result<Option<Rect>, AdapterError> {
        Err(AdapterError::not_supported("get_focused_insertion_caret"))
    }
}

pub(crate) use imp::{focused_insertion_caret, insertion_caret};

#[cfg(test)]
#[path = "text_insertion_tests.rs"]
mod tests;
