use super::DesktopStamp;
use std::path::PathBuf;
use std::time::{Duration, UNIX_EPOCH};

#[test]
fn stamp_with_the_build_time_ctime_is_not_trusted() {
    let built_at = UNIX_EPOCH + Duration::from_secs(10);
    let stamp = DesktopStamp {
        path: PathBuf::from("item.desktop"),
        version: Some((7, 12, 10, 0)),
    };
    let cutoff = built_at - Duration::from_millis(100);
    assert!(!stamp.is_older_than(cutoff));
}
