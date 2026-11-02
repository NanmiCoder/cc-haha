use agent_desktop_core::Rect;

use super::AXElement;

#[derive(Clone)]
pub(crate) struct TreeBuildContext {
    pub(crate) focused: Option<AXElement>,
    pub(crate) window_bounds: Option<Rect>,
    include_bounds: bool,
}

impl TreeBuildContext {
    pub(crate) fn for_pid_with_deadline(
        pid: i32,
        include_bounds: bool,
        deadline: std::time::Instant,
    ) -> Result<Self, agent_desktop_core::AdapterError> {
        let app = super::element_for_pid(pid);
        let focused =
            super::resolve::resolve_ax_read::read_element(&app, "AXFocusedUIElement", deadline)?;
        Ok(Self {
            focused,
            window_bounds: None,
            include_bounds,
        })
    }

    pub(crate) fn empty(include_bounds: bool) -> Self {
        Self {
            focused: None,
            window_bounds: None,
            include_bounds,
        }
    }

    pub(crate) fn child_context(&self, window_bounds: Option<Rect>) -> Self {
        Self {
            focused: self.focused.clone(),
            window_bounds: window_bounds.or(self.window_bounds),
            include_bounds: self.include_bounds,
        }
    }

    pub(crate) fn bounds_for(
        &self,
        bounds: Option<agent_desktop_core::Rect>,
    ) -> Option<agent_desktop_core::Rect> {
        if self.include_bounds { bounds } else { None }
    }
}
