pub(in crate::tree) struct ResolveReadContext {
    pub(in crate::tree) stats: agent_desktop_core::LocatorStats,
    pub(in crate::tree) usage: crate::tree::observation_usage::ObservationUsage,
    pub(in crate::tree) deadline: std::time::Instant,
}

impl ResolveReadContext {
    pub(in crate::tree) fn new(deadline: std::time::Instant) -> Self {
        Self {
            stats: agent_desktop_core::LocatorStats::default(),
            usage: crate::tree::observation_usage::ObservationUsage::new(
                agent_desktop_core::ObservationBudget::default(),
            ),
            deadline,
        }
    }
}
