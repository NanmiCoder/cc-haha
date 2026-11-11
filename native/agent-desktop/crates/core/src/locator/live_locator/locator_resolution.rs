use super::{LocatorMatch, LocatorResolutionMeta, LocatorStats};
use crate::refs::RefMap;

pub struct LocatorResolution {
    pub matches: Vec<LocatorMatch>,
    pub refmap: Option<RefMap>,
    pub stats: LocatorStats,
    pub meta: LocatorResolutionMeta,
}
