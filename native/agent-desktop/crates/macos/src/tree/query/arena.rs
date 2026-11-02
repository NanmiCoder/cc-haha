use agent_desktop_core::{AdapterError, LocatorStats};
use rustc_hash::FxHashSet;

pub(crate) struct TraversalArena {
    pub(crate) stats: LocatorStats,
    pub(crate) ancestors: FxHashSet<usize>,
    pub(crate) structurally_complete: bool,
    owned_handles: u64,
}

impl TraversalArena {
    pub(crate) fn new() -> Self {
        Self {
            stats: LocatorStats::default(),
            ancestors: FxHashSet::default(),
            structurally_complete: true,
            owned_handles: 0,
        }
    }

    pub(crate) fn add_handles(&mut self, count: usize) {
        self.owned_handles = self
            .owned_handles
            .saturating_add(u64::try_from(count).unwrap_or(u64::MAX));
        self.stats.traversal.peak_handles_owned = self
            .stats
            .traversal
            .peak_handles_owned
            .max(self.owned_handles);
    }

    pub(crate) fn drop_handles(&mut self, count: usize) {
        self.owned_handles = self
            .owned_handles
            .saturating_sub(u64::try_from(count).unwrap_or(u64::MAX));
    }

    pub(crate) fn mark_incomplete(&mut self) {
        self.structurally_complete = false;
    }

    pub(crate) fn finish(self) -> Result<LocatorStats, AdapterError> {
        if self.owned_handles != 0 {
            return Err(AdapterError::internal(format!(
                "observation retained {} native handles",
                self.owned_handles
            )));
        }
        Ok(self.stats)
    }
}
