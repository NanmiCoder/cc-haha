use super::app_alias::AliasIndex;
use crate::system::launch::desktop_lookup::{read_all, stamps};
use crate::system::launch::desktop_stamp::DesktopStamp;
use std::collections::hash_map::DefaultHasher;
use std::hash::{Hash, Hasher};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, PoisonError};
use std::time::{Duration, SystemTime};
type Stamps = Vec<DesktopStamp>;
type ContentHashes = Vec<(PathBuf, Option<u64>)>;
type CacheEntry = (Stamps, SystemTime, ContentHashes, Arc<AliasIndex>);

/// An index that is rebuilt only when a directory it was read from changes.
pub(crate) struct AliasCache {
    state: Mutex<Option<CacheEntry>>,
}

impl AliasCache {
    pub(crate) const fn new() -> Self {
        Self {
            state: Mutex::new(None),
        }
    }

    pub(crate) fn index(&self, dirs: &[PathBuf]) -> Arc<AliasIndex> {
        self.index_at(dirs, SystemTime::now())
    }

    fn index_at(&self, dirs: &[PathBuf], built_at: SystemTime) -> Arc<AliasIndex> {
        let now = stamps(dirs);
        let mut state = self.state.lock().unwrap_or_else(PoisonError::into_inner);
        if let Some((seen, _, hashes, index)) = state.as_ref()
            && *seen == now
            && hashes_match(hashes)
        {
            return Arc::clone(index);
        }
        let cutoff = built_at.checked_sub(Duration::from_millis(100));
        let hashes = content_hashes(&now, cutoff);
        let index = Arc::new(AliasIndex::build(&read_all(dirs), dirs));
        *state = Some((now, built_at, hashes, Arc::clone(&index)));
        index
    }
}

fn content_hashes(stamps: &[DesktopStamp], cutoff: Option<SystemTime>) -> ContentHashes {
    stamps
        .iter()
        .filter(|stamp| stamp.is_desktop_file())
        .filter(|stamp| !cutoff.is_some_and(|cutoff| stamp.is_older_than(cutoff)))
        .map(|stamp| (stamp.path().clone(), hash_file(stamp.path())))
        .collect()
}

fn hashes_match(hashes: &ContentHashes) -> bool {
    hashes
        .iter()
        .all(|(path, expected)| expected.is_some() && hash_file(path) == *expected)
}

fn hash_file(path: &Path) -> Option<u64> {
    let bytes = std::fs::read(path).ok()?;
    let mut hasher = DefaultHasher::new();
    bytes.hash(&mut hasher);
    Some(hasher.finish())
}

#[cfg(test)]
#[path = "alias_cache_tests.rs"]
mod tests;
