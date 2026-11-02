use std::path::Path;

use crate::{AppError, Deadline, storage::file_lock::FileLock};

const LOCK_TIMEOUT_MS: u64 = 2_000;

pub(crate) struct RefStoreLock {
    _lock: FileLock,
}

impl RefStoreLock {
    pub(crate) fn acquire(path: &Path) -> Result<Self, AppError> {
        let deadline = Deadline::after(LOCK_TIMEOUT_MS)?;
        Self::acquire_with_deadline(path, deadline)
    }

    /// Recovery-path lock: the budget is detached from the (possibly already
    /// expired) inherited command deadline. Use ONLY for post-deadline
    /// diagnostic work — e.g. persisting the last built snapshot after a wait
    /// timeout — which must run after the operation's own deadline has expired
    /// and must not collapse to an immediate `lock_timeout`.
    pub(crate) fn acquire_detached(path: &Path) -> Result<Self, AppError> {
        let deadline = Deadline::detached_after(LOCK_TIMEOUT_MS)?;
        Self::acquire_with_deadline(path, deadline)
    }

    pub(crate) fn acquire_with_deadline(path: &Path, deadline: Deadline) -> Result<Self, AppError> {
        Ok(Self {
            _lock: FileLock::acquire(path, deadline, "ref store lock")?,
        })
    }
}

pub(crate) fn lock_holder_is_live(lock_path: &Path) -> bool {
    FileLock::is_held(lock_path)
}

#[cfg(test)]
mod tests {
    use std::time::Duration;

    use super::*;

    fn lock_path(name: &str) -> std::path::PathBuf {
        std::env::temp_dir()
            .join(format!(
                "agent-desktop-{name}-{}-{}",
                std::process::id(),
                crate::refs::new_snapshot_id()
            ))
            .join("store.lock")
    }

    #[test]
    fn lock_is_released_without_deleting_the_lock_file() {
        let path = lock_path("release");
        {
            let _lock = RefStoreLock::acquire(&path).unwrap();
            assert!(lock_holder_is_live(&path));
        }
        assert!(path.is_file());
        assert!(!lock_holder_is_live(&path));
        let _lock = RefStoreLock::acquire(&path).unwrap();
    }

    #[test]
    fn contention_obeys_the_callers_deadline() {
        let path = lock_path("deadline");
        let _held = RefStoreLock::acquire(&path).unwrap();
        let deadline = Deadline::after(10).unwrap();
        let error = match RefStoreLock::acquire_with_deadline(&path, deadline) {
            Ok(_) => panic!("contended lock unexpectedly acquired"),
            Err(error) => error,
        };
        assert_eq!(error.code(), "TIMEOUT");
        assert!(deadline.elapsed() < Duration::from_secs(1));
    }

    #[test]
    fn acquire_collapses_to_lock_timeout_under_an_expired_inherited_deadline() {
        let path = lock_path("expired-inherited");
        let inherited = Deadline::after(0).unwrap();
        let _scope = crate::wait::deadline::enter_scope(Some(inherited));
        let error = match RefStoreLock::acquire(&path) {
            Ok(_) => panic!("expired inherited deadline must not acquire the lock"),
            Err(error) => error,
        };
        assert_eq!(error.code(), "TIMEOUT");
        let AppError::Adapter(adapter_err) = error else {
            panic!("expected adapter error");
        };
        let details = adapter_err.details.expect("lock timeout details");
        assert_eq!(details["kind"], "lock_timeout");
        assert_eq!(details["purpose"], "ref store lock");
        assert!(!lock_holder_is_live(&path));
    }

    #[test]
    fn lock_timeout_details_name_the_lock_file_without_its_directory() {
        let path = lock_path("redacted-directory");
        let inherited = Deadline::after(0).unwrap();
        let _scope = crate::wait::deadline::enter_scope(Some(inherited));
        let AppError::Adapter(adapter_err) = RefStoreLock::acquire(&path).err().unwrap() else {
            panic!("expected adapter error");
        };
        let details = adapter_err.details.expect("lock timeout details");
        assert_eq!(details["path"], "store.lock");
    }

    #[test]
    fn acquire_detached_survives_an_expired_inherited_deadline() {
        let path = lock_path("detached");
        let inherited = Deadline::after(0).unwrap();
        let _scope = crate::wait::deadline::enter_scope(Some(inherited));
        let _lock = RefStoreLock::acquire_detached(&path).unwrap();
        assert!(lock_holder_is_live(&path));
    }
}
