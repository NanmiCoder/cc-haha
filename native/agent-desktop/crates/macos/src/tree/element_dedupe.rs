use super::{AXElement, same_element};

pub(crate) fn push_unique(elements: &mut Vec<AXElement>, element: AXElement) -> bool {
    if elements
        .iter()
        .any(|existing| !existing.0.is_null() && same_element(existing, &element))
    {
        return false;
    }
    elements.push(element);
    true
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn null_elements_do_not_collapse_without_semantic_identity() {
        let mut elements = Vec::new();

        assert!(push_unique(&mut elements, null_element()));
        assert!(push_unique(&mut elements, null_element()));
        assert_eq!(elements.len(), 2);
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn same_ax_element_collapses_to_one_candidate() {
        let mut elements = Vec::new();
        let element = current_process_element();
        let same = element.clone();

        assert!(push_unique(&mut elements, element));
        assert!(!push_unique(&mut elements, same));
        assert_eq!(elements.len(), 1);
    }

    #[cfg(target_os = "macos")]
    fn null_element() -> AXElement {
        AXElement(std::ptr::null_mut())
    }

    #[cfg(target_os = "macos")]
    fn current_process_element() -> AXElement {
        AXElement(unsafe {
            accessibility_sys::AXUIElementCreateApplication(
                i32::try_from(std::process::id()).expect("test pid fits macOS pid_t"),
            )
        })
    }

    #[cfg(not(target_os = "macos"))]
    fn null_element() -> AXElement {
        AXElement(std::ptr::null())
    }
}
