use std::os::unix::fs::MetadataExt;
use std::path::PathBuf;
use std::time::{SystemTime, UNIX_EPOCH};

#[derive(PartialEq, Eq)]
pub(crate) struct DesktopStamp {
    path: PathBuf,
    version: Option<(u64, u64, i64, i64)>,
}

impl DesktopStamp {
    pub(in crate::system) fn read(path: PathBuf) -> Self {
        let version = std::fs::metadata(&path).ok().map(|metadata| {
            (
                metadata.ino(),
                metadata.len(),
                metadata.ctime(),
                metadata.ctime_nsec(),
            )
        });
        Self { path, version }
    }

    pub(crate) fn is_older_than(&self, cutoff: SystemTime) -> bool {
        let Some((_, _, seconds, nanoseconds)) = self.version else {
            return false;
        };
        let Ok(cutoff) = cutoff.duration_since(UNIX_EPOCH) else {
            return false;
        };
        (seconds as u64, nanoseconds as u32) < (cutoff.as_secs(), cutoff.subsec_nanos())
    }

    pub(crate) fn path(&self) -> &PathBuf {
        &self.path
    }

    pub(crate) fn is_desktop_file(&self) -> bool {
        self.path
            .extension()
            .is_some_and(|extension| extension == "desktop")
    }
}

#[cfg(test)]
#[path = "desktop_stamp_tests.rs"]
mod tests;
