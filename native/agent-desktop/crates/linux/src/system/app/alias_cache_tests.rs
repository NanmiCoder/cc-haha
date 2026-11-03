use super::AliasCache;
use std::path::PathBuf;
use std::sync::Arc;
use std::time::{Duration, SystemTime};

fn fixture() -> (PathBuf, PathBuf, AliasCache) {
    let dir = std::env::temp_dir().join(crate::tree::live::live_launch::nonce("alias-cache-test"));
    std::fs::create_dir_all(&dir).unwrap();
    let file = dir.join("entry.desktop");
    std::fs::write(&file, "[Desktop Entry]\nName=One\n").unwrap();
    (dir, file, AliasCache::new())
}

#[test]
fn racy_unchanged_file_reuses_the_index() {
    let (dir, _, cache) = fixture();
    let dirs = [dir.clone()];
    let now = SystemTime::now();
    let first = cache.index_at(&dirs, now);
    assert!(Arc::ptr_eq(&first, &cache.index_at(&dirs, now)));
    std::fs::remove_dir_all(dir).unwrap();
}

#[test]
fn racy_content_change_rebuilds_when_stamps_are_unchanged() {
    let (dir, file, cache) = fixture();
    let dirs = [dir.clone()];
    let now = SystemTime::now();
    let first = cache.index_at(&dirs, now);
    std::fs::write(&file, "[Desktop Entry]\nName=Two\n").unwrap();
    cache.state.lock().unwrap().as_mut().unwrap().0 = super::stamps(&dirs);
    assert!(!Arc::ptr_eq(&first, &cache.index_at(&dirs, now)));
    std::fs::remove_dir_all(dir).unwrap();
}

#[test]
fn file_older_than_margin_is_not_hashed_again() {
    let (dir, _, cache) = fixture();
    let dirs = [dir.clone()];
    let now = SystemTime::now() + Duration::from_secs(1);
    let first = cache.index_at(&dirs, now);
    assert!(cache.state.lock().unwrap().as_ref().unwrap().2.is_empty());
    assert!(Arc::ptr_eq(&first, &cache.index_at(&dirs, now)));
    std::fs::remove_dir_all(dir).unwrap();
}
