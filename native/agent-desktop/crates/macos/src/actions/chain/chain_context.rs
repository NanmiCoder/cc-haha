pub(crate) struct ChainContext<'a> {
    pub(crate) dynamic_value: Option<&'a str>,
    pub(crate) verified_point: Option<&'a agent_desktop_core::Point>,
    pub(crate) deadline: agent_desktop_core::Deadline,
}

impl ChainContext<'_> {
    pub(crate) fn remaining(
        &self,
    ) -> Result<std::time::Duration, agent_desktop_core::AdapterError> {
        let remaining = self.deadline.remaining();
        if remaining.is_zero() {
            Err(self.deadline.timeout_error())
        } else {
            Ok(remaining)
        }
    }

    pub(crate) fn ensure_budget(&self) -> Result<(), agent_desktop_core::AdapterError> {
        self.remaining().map(|_| ())
    }
}
