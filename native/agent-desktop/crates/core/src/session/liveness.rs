use crate::{AppError, Deadline, refs::refs_lock::RefStoreLock, storage::file_lock::FileLock};
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::sync::atomic::{AtomicU64, Ordering};

static LEASE_COUNTER: AtomicU64 = AtomicU64::new(0);

#[derive(Clone)]
pub struct SessionLivenessLease {
    inner: Arc<LeaseInner>,
}

impl std::fmt::Debug for SessionLivenessLease {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter
            .debug_struct("SessionLivenessLease")
            .field("path", &self.inner.path)
            .finish()
    }
}

struct LeaseInner {
    lock: Option<FileLock>,
    path: PathBuf,
}

impl Drop for LeaseInner {
    fn drop(&mut self) {
        drop(self.lock.take());
        let _ = std::fs::remove_file(&self.path);
    }
}

pub fn acquire(
    session_id: &str,
    deadline: Deadline,
) -> Result<Option<SessionLivenessLease>, AppError> {
    let store = crate::refs::refs_store::RefStore::for_session(Some(session_id))?;
    let base = store.base_dir();
    if !base.is_dir() {
        return Ok(None);
    }
    let _store_lock = RefStoreLock::acquire_with_deadline(&base.join("refstore.lock"), deadline)?;
    if super::read_manifest(session_id)?.is_none() {
        return Ok(None);
    }
    let directory = base.join("liveness");
    crate::storage::private_file_parent::ensure_private(&directory)?;
    let path = directory.join(lease_filename());
    let lock = FileLock::acquire(&path, deadline, "session liveness lease")?;
    Ok(Some(SessionLivenessLease {
        inner: Arc::new(LeaseInner {
            lock: Some(lock),
            path,
        }),
    }))
}

pub(super) fn any_held(base: &Path) -> bool {
    let directory = base.join("liveness");
    let Ok(entries) = std::fs::read_dir(directory) else {
        return false;
    };
    entries.flatten().any(|entry| {
        entry.file_type().is_ok_and(|file_type| file_type.is_file())
            && FileLock::is_held(&entry.path())
    })
}

fn lease_filename() -> String {
    let sequence = LEASE_COUNTER.fetch_add(1, Ordering::Relaxed);
    let timestamp = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|duration| duration.as_nanos())
        .unwrap_or(0);
    format!("{}-{timestamp}-{sequence}.lock", std::process::id())
}
