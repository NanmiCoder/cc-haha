use crate::AppError;
pub(crate) use crate::RefEntry;
use serde::{Deserialize, Serialize};
use smallvec::SmallVec;
use std::cell::RefCell;
use std::collections::HashMap;
use std::collections::hash_map::RandomState;
use std::hash::BuildHasher;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{SystemTime, UNIX_EPOCH};

pub type RefPath = SmallVec<[usize; 8]>;

pub(crate) const MAX_REFMAP_BYTES: u64 = 1_048_576;
static SNAPSHOT_COUNTER: AtomicU64 = AtomicU64::new(0);

thread_local! {
    static HOME_OVERRIDE: RefCell<Option<PathBuf>> = const { RefCell::new(None) };
}

/// A write that fails at a path the caller named is a problem with that path,
/// not a missing OS permission, so it is an argument error rather than the
/// `PERM_DENIED` or `INTERNAL` the generic io mapping would give it.
pub(crate) fn unwritable_output(what: &str, path: &Path, error: AppError) -> AppError {
    match error {
        AppError::Io(io) => AppError::invalid_input_with_suggestion(
            format!("Cannot write {what} to '{}': {io}", path.display()),
            "Pass an output path in a directory this user can write to; missing parent directories are created",
        ),
        other => other,
    }
}

pub fn validate_ref_id(ref_id: &str) -> Result<(), AppError> {
    crate::refs::ref_token::validate_ref_token(ref_id)
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RefMap {
    inner: HashMap<String, RefEntry>,
    counter: u32,
}

impl RefMap {
    pub fn new() -> Self {
        Self {
            inner: HashMap::new(),
            counter: 0,
        }
    }

    pub fn try_allocate(&mut self, entry: RefEntry) -> Result<String, AppError> {
        crate::refs::refs_validate::validate_ref_entry(&entry)?;
        self.allocate_validated(entry)
    }

    pub(crate) fn try_allocate_observed(
        &mut self,
        entry: RefEntry,
    ) -> Result<crate::refs::ref_allocation::RefAllocation, AppError> {
        if !crate::Role::is_canonical(&entry.identity.role) || entry.identity.role == "unknown" {
            return Ok(crate::refs::ref_allocation::RefAllocation::SkippedInvalidRole);
        }
        if crate::refs::refs_validate::validate_ref_entry(&entry).is_err() {
            return Ok(crate::refs::ref_allocation::RefAllocation::SkippedInvalidEntry);
        }
        self.allocate_validated(entry)
            .map(crate::refs::ref_allocation::RefAllocation::Allocated)
    }

    fn allocate_validated(&mut self, entry: RefEntry) -> Result<String, AppError> {
        self.counter = self
            .counter
            .checked_add(1)
            .ok_or_else(|| AppError::invalid_input("RefMap exhausted its identifier space"))?;
        let ref_id = format!("@e{}", self.counter);
        self.inner.insert(ref_id.clone(), entry);
        Ok(ref_id)
    }

    #[cfg(test)]
    pub fn allocate(&mut self, entry: RefEntry) -> String {
        self.try_allocate(entry)
            .expect("test RefEntry must be valid")
    }

    pub fn get(&self, ref_id: &str) -> Option<&RefEntry> {
        self.inner.get(ref_id)
    }

    pub fn len(&self) -> usize {
        self.inner.len()
    }

    pub fn is_empty(&self) -> bool {
        self.inner.is_empty()
    }

    pub(crate) fn retained_object_tokens(&self) -> impl Iterator<Item = &str> {
        self.inner
            .values()
            .filter_map(|entry| entry.identity.retained_object.as_deref())
    }

    pub fn remove_by_root_ref(&mut self, root: &str) {
        let root_entry = self.inner.get(root).cloned();
        self.inner.retain(|ref_id, entry| {
            if ref_id == root {
                return true;
            }
            let owned = entry.scope.root_ref.as_deref() == Some(root);
            let descendant = root_entry.as_ref().is_some_and(|parent| {
                entry.process == parent.process
                    && entry.source == parent.source
                    && (parent.scope.root_ref.is_none() || parent.scope.path_is_absolute)
                    && (entry.scope.root_ref.is_none() || entry.scope.path_is_absolute)
                    && entry.scope.path.starts_with(&parent.scope.path)
                    && (entry.scope.path.len() > parent.scope.path.len()
                        || entry.scope.root_ref.is_some())
            });
            !owned && !descendant
        });
    }

    pub fn validate(&self) -> Result<(), AppError> {
        let mut max_id = 0_u32;
        for (ref_id, entry) in &self.inner {
            let numeric = ref_id
                .strip_prefix("@e")
                .and_then(|value| value.parse::<u32>().ok())
                .filter(|value| *value > 0)
                .ok_or_else(|| AppError::invalid_input("RefMap contains an invalid ref key"))?;
            if format!("@e{numeric}") != *ref_id {
                return Err(AppError::invalid_input(
                    "RefMap contains a non-canonical ref key",
                ));
            }
            max_id = max_id.max(numeric);
            crate::refs::refs_validate::validate_ref_entry(entry)?;
        }
        if self.counter < max_id || self.counter == u32::MAX {
            return Err(AppError::invalid_input(
                "RefMap counter is inconsistent with its allocated refs",
            ));
        }
        Ok(())
    }

    pub(crate) fn serialize_with_size_check(&self) -> Result<String, AppError> {
        self.validate()?;
        let json = serde_json::to_string(self)?;
        if json.len() as u64 > MAX_REFMAP_BYTES {
            return Err(crate::AdapterError::internal("RefMap exceeds 1MB size limit on write")
                .with_suggestion(
                    "Narrow the observation: snapshot with --skeleton, --max-depth, or --root @ref, or use find with a tighter query or --limit",
                )
                .into());
        }
        Ok(json)
    }

    #[cfg(test)]
    pub(crate) fn save(&self) -> Result<(), AppError> {
        let json = self.serialize_with_size_check()?;
        let path = refmap_path()?;
        write_private_file(&path, json.as_bytes())
    }

    pub fn load() -> Result<Self, AppError> {
        let path = refmap_path()?;
        let json = crate::storage::private_file::read_private_bounded(&path, MAX_REFMAP_BYTES)?;
        let map: Self = serde_json::from_slice(&json)?;
        map.validate()?;
        Ok(map)
    }
}

impl Default for RefMap {
    fn default() -> Self {
        Self::new()
    }
}

fn refmap_path() -> Result<PathBuf, AppError> {
    Ok(crate::storage::state_root::resolve_configured_state_root()?.join("last_refmap.json"))
}

pub(crate) fn new_snapshot_id() -> String {
    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_nanos() as u64)
        .unwrap_or(0);
    let counter = SNAPSHOT_COUNTER.fetch_add(1, Ordering::Relaxed);
    let seed = RandomState::new();
    let mixed = seed.hash_one((nanos, std::process::id(), counter));
    format!("s{}", base36(mixed))
}

fn base36(mut value: u64) -> String {
    const DIGITS: &[u8; 36] = b"0123456789abcdefghijklmnopqrstuvwxyz";
    const MIN_LEN: usize = 4;

    let mut buf = [b'0'; 13];
    let mut i = buf.len();
    if value == 0 {
        i -= 1;
    } else {
        while value > 0 {
            i -= 1;
            buf[i] = DIGITS[(value % 36) as usize];
            value /= 36;
        }
    }

    let digits = buf.len() - i;
    if digits < MIN_LEN {
        let pad = MIN_LEN - digits;
        i -= pad;
    }

    String::from_utf8_lossy(&buf[i..]).into_owned()
}

pub fn validate_snapshot_id(snapshot_id: &str) -> Result<(), AppError> {
    let valid = snapshot_id.len() <= 64
        && snapshot_id.len() >= 3
        && snapshot_id
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_');
    if !valid {
        return Err(AppError::invalid_input(format!(
            "Invalid snapshot_id '{snapshot_id}': use the value returned by snapshot"
        )));
    }
    Ok(())
}

pub(crate) fn write_private_file(path: &Path, bytes: &[u8]) -> Result<(), AppError> {
    crate::storage::private_file::write_atomic(path, bytes).map_err(AppError::from)
}

/// Writes user-requested output for `screenshot` and `clipboard get`.
///
/// Unlike `write_private_file`, this does not route through the
/// `PrivateFileOps` seam: the destination is user-chosen and must tolerate
/// remote, reparse-traversing, and foreign-owned paths that the private
/// policy refuses. See `crate::storage::private_file::write_user_atomic`.
pub(crate) fn write_user_file(path: &Path, bytes: &[u8]) -> Result<(), AppError> {
    crate::storage::private_file::write_user_atomic(path, bytes).map_err(|error| {
        if error.kind() == std::io::ErrorKind::InvalidData {
            AppError::invalid_input_with_suggestion(
                format!("Cannot write output file: {error}"),
                format!(
                    "Pass an output path that is not '{}' or remove the conflicting entry there",
                    path.display()
                ),
            )
        } else {
            AppError::from(error)
        }
    })
}

pub(crate) fn is_symlink(path: &Path) -> bool {
    std::fs::symlink_metadata(path)
        .map(|meta| meta.file_type().is_symlink())
        .unwrap_or(false)
}

pub(crate) fn open_nofollow(path: &Path) -> std::io::Result<std::fs::File> {
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        let file = std::fs::OpenOptions::new()
            .read(true)
            .custom_flags(libc::O_NOFOLLOW | libc::O_NONBLOCK | libc::O_CLOEXEC)
            .open(path)?;
        crate::storage::private_file::validate_regular(&file)?;
        Ok(file)
    }
    #[cfg(not(unix))]
    {
        if std::fs::symlink_metadata(path)?.file_type().is_symlink() {
            return Err(std::io::Error::new(
                std::io::ErrorKind::PermissionDenied,
                "path must not be a symlink",
            ));
        }
        let file = std::fs::File::open(path)?;
        crate::storage::private_file::validate_regular(&file)?;
        Ok(file)
    }
}

pub(crate) fn home_dir() -> Option<PathBuf> {
    let home = HOME_OVERRIDE
        .with(|cell| cell.borrow().clone())
        .or_else(|| std::env::var_os("HOME").map(PathBuf::from))
        .or_else(|| std::env::var_os("USERPROFILE").map(PathBuf::from))?;
    validate_home_dir(&home).then_some(home)
}

fn validate_home_dir(home: &Path) -> bool {
    let Ok(link_meta) = std::fs::symlink_metadata(home) else {
        return false;
    };
    if link_meta.file_type().is_symlink() {
        return false;
    }
    let Ok(meta) = std::fs::metadata(home) else {
        return false;
    };
    if !meta.is_dir() {
        return false;
    }
    crate::storage::state_root::is_owned_by_current_user(&meta)
}

#[cfg(test)]
pub(crate) fn set_home_override(home: Option<PathBuf>) -> Option<PathBuf> {
    HOME_OVERRIDE.with(|cell| std::mem::replace(&mut *cell.borrow_mut(), home))
}

pub(crate) fn home_override_active() -> bool {
    HOME_OVERRIDE.with(|cell| cell.borrow().is_some())
}

pub mod ref_alloc;
pub(crate) mod ref_alloc_config;
pub(crate) mod ref_alloc_options;
pub(crate) mod ref_alloc_scope;
pub(crate) mod ref_alloc_source;
pub(crate) mod ref_allocation;
pub(crate) mod ref_capabilities;
pub(crate) mod ref_entry;
pub(crate) mod ref_entry_identity;
pub(crate) mod ref_geometry;
pub mod ref_identity;
pub(crate) mod ref_identity_match;
pub(crate) mod ref_process;
pub(crate) mod ref_resolve_deadline;
pub(crate) mod ref_scope;
pub(crate) mod ref_source;
pub(crate) mod ref_token;
pub(crate) mod refs_lock;
pub mod refs_store;
#[cfg(test)]
pub(crate) mod refs_test_support;
pub(crate) mod refs_validate;
pub(crate) mod resolve_attempt_outcome;
pub mod resolve_errors;
#[cfg(test)]
#[path = "refs_tests.rs"]
mod tests;

#[cfg(test)]
#[path = "refs_serde_tests.rs"]
mod serde_tests;

#[cfg(test)]
#[path = "refs_size_tests.rs"]
mod size_tests;
