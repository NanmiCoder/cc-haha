#[derive(Default)]
pub(crate) struct ChildReadStatus {
    pub(crate) attempts: u64,
    pub(crate) health: agent_desktop_core::LocatorReadHealth,
    pub(crate) invalid_element: bool,
    pub(crate) api_disabled: bool,
    pub(crate) count_changed: bool,
    pub(crate) cursor_stalled: bool,
}

impl ChildReadStatus {
    pub(crate) fn merge(&mut self, other: Self) {
        self.attempts += other.attempts;
        self.health.cannot_complete += other.health.cannot_complete;
        self.health.native_read_failures += other.health.native_read_failures;
        self.health.deadline_exhausted = self
            .health
            .deadline_exhausted
            .max(other.health.deadline_exhausted);
        self.invalid_element |= other.invalid_element;
        self.api_disabled |= other.api_disabled;
        self.count_changed |= other.count_changed;
        self.cursor_stalled |= other.cursor_stalled;
    }
}
