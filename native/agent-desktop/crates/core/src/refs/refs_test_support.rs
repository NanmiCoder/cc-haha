use std::fs;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{SystemTime, UNIX_EPOCH};

static COUNTER: AtomicU64 = AtomicU64::new(0);

pub(crate) struct HomeGuard {
    _dir: TempDir,
    prev: Option<PathBuf>,
}

impl HomeGuard {
    pub(crate) fn new() -> Self {
        let dir = TempDir::new();
        let prev = crate::refs::set_home_override(Some(dir.path().to_path_buf()));
        Self { _dir: dir, prev }
    }

    pub(crate) fn path(&self) -> &Path {
        self._dir.path()
    }
}

impl Drop for HomeGuard {
    fn drop(&mut self) {
        let prev = self.prev.take();
        crate::refs::set_home_override(prev);
    }
}

pub(crate) struct TempDir(PathBuf);

impl TempDir {
    pub(crate) fn new() -> Self {
        let n = COUNTER.fetch_add(1, Ordering::SeqCst);
        let nanos = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map(|d| d.as_nanos())
            .unwrap_or(0);
        let path = std::env::temp_dir().join(format!("agent-desktop-test-{nanos}-{n}"));
        fs::create_dir_all(&path).expect("create tempdir");
        Self(path)
    }

    pub(crate) fn path(&self) -> &Path {
        &self.0
    }
}

impl Drop for TempDir {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.0);
    }
}
