pub(crate) struct ReadonlyRead {
    pub(crate) value: Option<bool>,
    pub(crate) error: Option<i32>,
    pub(crate) attempted: bool,
    pub(crate) deadline_exhausted: bool,
}

#[cfg(target_os = "macos")]
pub(crate) fn read_readonly(
    element: &crate::tree::AXElement,
    role: Option<&str>,
    deadline: std::time::Instant,
) -> ReadonlyRead {
    if !editable_ax_role(role) {
        return ReadonlyRead {
            value: None,
            error: None,
            attempted: false,
            deadline_exhausted: false,
        };
    }
    if crate::tree::locator_deadline::remaining(deadline).is_err() {
        return ReadonlyRead {
            value: None,
            error: None,
            attempted: false,
            deadline_exhausted: true,
        };
    }
    let read = super::capabilities::is_attr_settable_with_status(element, "AXValue", deadline);
    ReadonlyRead {
        value: read.value.map(|settable| !settable),
        error: read.error,
        attempted: true,
        deadline_exhausted: false,
    }
}

#[cfg(target_os = "macos")]
fn editable_ax_role(role: Option<&str>) -> bool {
    matches!(
        role,
        Some(
            "AXTextField"
                | "AXTextArea"
                | "AXSearchField"
                | "AXComboBox"
                | "AXPopUpButton"
                | "AXIncrementor"
                | "AXStepper"
                | "AXSlider"
                | "AXValueIndicator"
        )
    )
}
