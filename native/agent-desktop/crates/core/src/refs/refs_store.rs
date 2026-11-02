use crate::{
    AdapterError, AppError,
    context::validate_session_id,
    refs::refs_lock::RefStoreLock,
    refs::{RefMap, new_snapshot_id, validate_snapshot_id, write_private_file},
};
use std::io::ErrorKind;
use std::path::{Path, PathBuf};

const LATEST_SNAPSHOT_FILE: &str = "latest_snapshot_id";

/// Refs are invalidated by the next UI change, so retention only has to cover
/// the handful of snapshots an agent drills through within one interaction.
/// Pruning to a low-water mark keeps the sort-and-stat pass off the common
/// save, which otherwise paid it on every snapshot once the cap was reached.
const MAX_SAVED_SNAPSHOTS: usize = 128;
pub(crate) const PRUNE_LOW_WATER: usize = 96;
pub(crate) const STALE_TMP_MAX_AGE: std::time::Duration = std::time::Duration::from_secs(60);

#[derive(Debug, Clone)]
pub struct RefStore {
    base_dir: PathBuf,
    allow_legacy_migration: bool,
}

impl RefStore {
    pub fn new() -> Result<Self, AppError> {
        Self::for_session(None)
    }

    pub fn for_session(session_id: Option<&str>) -> Result<Self, AppError> {
        let state_root = crate::storage::state_root::resolve_configured_state_root()?;
        if let Some(session_id) = session_id {
            validate_session_id(session_id)?;
            return Ok(Self {
                base_dir: state_root.join("sessions").join(session_id),
                allow_legacy_migration: false,
            });
        }
        Ok(Self {
            base_dir: state_root,
            allow_legacy_migration: true,
        })
    }

    pub fn save_new_snapshot(&self, refmap: &RefMap) -> Result<String, AppError> {
        self.with_write_lock(|| self.save_new_snapshot_unlocked_with_id(refmap))
    }

    /// Recovery-path variant of [`save_new_snapshot`]: the ref-store write
    /// lock is acquired with a deadline detached from any inherited (and
    /// possibly already-expired) command deadline. Used by post-timeout
    /// diagnostic persistence, which runs after the operation's own deadline
    /// has expired and must not collapse to an immediate `lock_timeout` that
    /// would replace the intended `wait_timeout` envelope.
    pub(crate) fn save_new_snapshot_detached(&self, refmap: &RefMap) -> Result<String, AppError> {
        self.with_write_lock_detached(|| self.save_new_snapshot_unlocked_with_id(refmap))
    }

    fn save_new_snapshot_unlocked_with_id(&self, refmap: &RefMap) -> Result<String, AppError> {
        let snapshot_id = new_snapshot_id();
        self.save_snapshot_unlocked(&snapshot_id, refmap)?;
        self.set_latest_unlocked(&snapshot_id)?;
        self.prune_old_snapshots_unlocked(&snapshot_id)?;
        Ok(snapshot_id)
    }

    pub fn save_snapshot(&self, snapshot_id: &str, refmap: &RefMap) -> Result<(), AppError> {
        self.with_write_lock(|| self.save_snapshot_unlocked(snapshot_id, refmap))
    }

    pub(crate) fn update_existing_snapshot<T>(
        &self,
        snapshot_id: &str,
        expected_ref_id: &str,
        expected_entry: &crate::RefEntry,
        update: impl FnOnce(&mut RefMap) -> Result<T, AppError>,
    ) -> Result<(T, RefMap), AppError> {
        validate_snapshot_id(snapshot_id)?;
        self.with_write_lock(|| {
            let mut current = self.load_snapshot_from_base(&self.base_dir, snapshot_id)?;
            if current.get(expected_ref_id) != Some(expected_entry) {
                return Err(AppError::Adapter(AdapterError::stale_ref(expected_ref_id)));
            }
            let value = update(&mut current)?;
            self.save_snapshot_unlocked(snapshot_id, &current)?;
            Ok((value, current))
        })
    }

    pub fn load(&self, snapshot_id: Option<&str>) -> Result<RefMap, AppError> {
        match snapshot_id {
            Some(id) => self.load_snapshot(id),
            None => self.load_latest(),
        }
    }

    pub fn load_ref(&self, ref_id: &str) -> Result<crate::RefEntry, AppError> {
        let (snapshot_id, local_ref) = crate::refs::ref_token::resolve_ref_target(ref_id)?;
        self.load_snapshot(&snapshot_id)?
            .get(&local_ref)
            .cloned()
            .ok_or_else(|| AppError::stale_ref(ref_id))
    }

    pub fn load_latest(&self) -> Result<RefMap, AppError> {
        if let Some(id) = self.read_latest_snapshot_id()? {
            return self.load_snapshot_from_base(&self.base_dir, &id);
        }
        if let Some(refmap) = self.migrate_legacy_latest()? {
            return Ok(refmap);
        }
        Err(AppError::Adapter(AdapterError::snapshot_not_found(
            "latest",
        )))
    }

    pub fn load_snapshot(&self, snapshot_id: &str) -> Result<RefMap, AppError> {
        validate_snapshot_id(snapshot_id)?;
        self.load_snapshot_from_base(&self.base_dir, snapshot_id)
    }

    fn load_snapshot_from_base(
        &self,
        base_dir: &Path,
        snapshot_id: &str,
    ) -> Result<RefMap, AppError> {
        validate_snapshot_id(snapshot_id)?;
        self.read_snapshot_if_present(base_dir, snapshot_id)?
            .ok_or_else(|| AppError::Adapter(AdapterError::snapshot_not_found(snapshot_id)))
    }

    fn read_snapshot_if_present(
        &self,
        base_dir: &Path,
        snapshot_id: &str,
    ) -> Result<Option<RefMap>, AppError> {
        let path = Self::snapshot_path_for_base(base_dir, snapshot_id);
        let json = match crate::storage::private_file::read_private_bounded(
            &path,
            crate::refs::MAX_REFMAP_BYTES,
        ) {
            Ok(json) => json,
            Err(err) if err.kind() == ErrorKind::NotFound => return Ok(None),
            Err(err) => return Err(err.into()),
        };
        let refmap: RefMap = serde_json::from_slice(&json)?;
        refmap.validate()?;
        Ok(Some(refmap))
    }

    pub fn set_latest(&self, snapshot_id: &str) -> Result<(), AppError> {
        self.with_write_lock(|| self.set_latest_unlocked(snapshot_id))
    }

    pub fn latest_snapshot_id(&self) -> Result<Option<String>, AppError> {
        self.read_latest_snapshot_id()
    }

    pub fn retained_object_tokens(&self) -> Result<std::collections::HashSet<String>, AppError> {
        self.with_write_lock(|| {
            let entries = match std::fs::read_dir(self.snapshots_dir()) {
                Ok(entries) => entries,
                Err(error) if error.kind() == ErrorKind::NotFound => return Ok(Default::default()),
                Err(error) => return Err(error.into()),
            };
            let mut tokens = std::collections::HashSet::new();
            let mut candidates = 0_usize;
            for entry in entries {
                let entry = entry?;
                let id = entry.file_name().to_string_lossy().into_owned();
                if validate_snapshot_id(&id).is_err() {
                    continue;
                }
                candidates += 1;
                if candidates > MAX_SAVED_SNAPSHOTS {
                    return Err(AppError::invalid_input(
                        "Snapshot inventory exceeds retention limit",
                    ));
                }
                let map = self.load_snapshot(&id)?;
                tokens.extend(map.retained_object_tokens().map(str::to_owned));
            }
            Ok(tokens)
        })
    }

    fn save_snapshot_unlocked(&self, snapshot_id: &str, refmap: &RefMap) -> Result<(), AppError> {
        validate_snapshot_id(snapshot_id)?;
        let json = refmap.serialize_with_size_check()?;
        let path = self.snapshot_path(snapshot_id);
        write_private_file(&path, json.as_bytes())
    }

    fn set_latest_unlocked(&self, snapshot_id: &str) -> Result<(), AppError> {
        validate_snapshot_id(snapshot_id)?;
        write_private_file(&self.latest_path(), snapshot_id.as_bytes())
    }

    fn latest_path(&self) -> PathBuf {
        self.base_dir.join(LATEST_SNAPSHOT_FILE)
    }

    fn read_latest_snapshot_id(&self) -> Result<Option<String>, AppError> {
        let bytes =
            match crate::storage::private_file::read_private_bounded(&self.latest_path(), 65) {
                Ok(bytes) => bytes,
                Err(err) if err.kind() == ErrorKind::NotFound => return Ok(None),
                Err(err) => return Err(err.into()),
            };
        let id = std::str::from_utf8(&bytes)
            .map_err(|_| AppError::invalid_input("latest_snapshot_id must be UTF-8"))?
            .trim()
            .to_string();
        if id.is_empty() {
            return Ok(None);
        }
        validate_snapshot_id(&id)?;
        Ok(Some(id))
    }

    fn snapshot_path(&self, snapshot_id: &str) -> PathBuf {
        Self::snapshot_path_for_base(&self.base_dir, snapshot_id)
    }

    fn snapshot_path_for_base(base_dir: &Path, snapshot_id: &str) -> PathBuf {
        base_dir
            .join("snapshots")
            .join(snapshot_id)
            .join("refmap.json")
    }

    pub(crate) fn base_dir(&self) -> &Path {
        &self.base_dir
    }

    pub(crate) fn trace_dir(&self) -> PathBuf {
        self.base_dir.join("trace")
    }

    fn snapshots_dir(&self) -> PathBuf {
        self.base_dir.join("snapshots")
    }

    fn lock_path(&self) -> PathBuf {
        self.base_dir.join("refstore.lock")
    }

    fn with_write_lock<T>(&self, f: impl FnOnce() -> Result<T, AppError>) -> Result<T, AppError> {
        let _lock = RefStoreLock::acquire(&self.lock_path())?;
        f()
    }

    /// Recovery-path write lock: uses [`RefStoreLock::acquire_detached`] so the
    /// lock budget survives an inherited command deadline that has already
    /// expired by the time post-deadline diagnostic work runs.
    fn with_write_lock_detached<T>(
        &self,
        f: impl FnOnce() -> Result<T, AppError>,
    ) -> Result<T, AppError> {
        let _lock = RefStoreLock::acquire_detached(&self.lock_path())?;
        f()
    }

    fn migrate_legacy_latest(&self) -> Result<Option<RefMap>, AppError> {
        if !self.allow_legacy_migration {
            return Ok(None);
        }
        self.with_write_lock(|| {
            if let Some(id) = self.read_latest_snapshot_id()? {
                return self.load_snapshot_from_base(&self.base_dir, &id).map(Some);
            }
            let refmap = match RefMap::load() {
                Ok(refmap) => refmap,
                Err(err) => {
                    tracing::debug!("legacy last_refmap.json migration skipped: {err}");
                    return Ok(None);
                }
            };
            let snapshot_id = new_snapshot_id();
            self.save_snapshot_unlocked(&snapshot_id, &refmap)?;
            self.set_latest_unlocked(&snapshot_id)?;
            Ok(Some(refmap))
        })
    }
}

/// Pruning logic is a sibling `#[path]` module rather than a separate crate
/// module so it can access `base_dir`/`snapshots_dir` directly, without
/// widening those fields' visibility beyond this module tree. The module
/// itself is `pub(crate)` so its standalone, non-`RefStore` age-based-prune
/// helper is reachable from other commands that need the same TTL sweep.
#[path = "refs_store_prune.rs"]
pub(crate) mod prune;

#[cfg(test)]
#[path = "refs_store_tests.rs"]
mod tests;

#[cfg(test)]
#[path = "refs_store_trace_tests.rs"]
mod trace_tests;

#[cfg(test)]
#[path = "refs_store_transaction_tests.rs"]
mod transaction_tests;

#[cfg(test)]
#[path = "refs_store_retained_tests.rs"]
mod retained_tests;
