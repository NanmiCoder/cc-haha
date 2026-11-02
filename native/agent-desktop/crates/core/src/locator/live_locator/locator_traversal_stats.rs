use serde::Serialize;

use super::LocatorLimitStats;

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize)]
pub struct LocatorTraversalStats {
    pub nodes_visited: u64,
    pub peak_handles_owned: u64,
    pub max_raw_depth: u8,
    pub max_logical_depth: u8,
    pub web_wrapper_nodes: u64,
    pub cycles_skipped: u64,
    pub limits: LocatorLimitStats,
}
