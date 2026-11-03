pub const ABSOLUTE_MAX_DEPTH: u8 = 50;

pub(crate) fn child_attributes(ax_role: Option<&str>) -> &'static [&'static str] {
    if ax_role == Some("AXBrowser") {
        &["AXColumns", "AXContents"]
    } else if ax_role == Some("AXApplication") {
        &["AXWindows", "AXChildren"]
    } else {
        &["AXChildren", "AXChildrenInNavigationOrder", "AXContents"]
    }
}

#[cfg(target_os = "macos")]
mod imp {
    use crate::tree::ax_element::AXElement;
    use accessibility_sys::AXUIElementCreateApplication;

    pub fn element_for_pid(pid: i32) -> AXElement {
        AXElement(unsafe { AXUIElementCreateApplication(pid) })
    }
}

#[cfg(not(target_os = "macos"))]
mod imp {
    use crate::tree::ax_element::AXElement;

    pub fn element_for_pid(_pid: i32) -> AXElement {
        AXElement(std::ptr::null())
    }
}

pub(crate) use crate::tree::properties::node_attribute_fetch::fetch_node_attrs_with_status_for;
pub(crate) use imp::element_for_pid;

#[cfg(test)]
#[path = "element_tests.rs"]
mod tests;
