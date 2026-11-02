use super::{SessionManifest, TRACE_LIVENESS_WINDOW, list_sessions, now_millis, read_manifest};
use crate::{
    AppError,
    context::validate_session_id,
    refs::refs_lock::{RefStoreLock, lock_holder_is_live},
    refs::refs_store::RefStore,
};
use std::path::Path;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

pub struct GcOptions {
    /// Consider only sessions that have ended. An ended session takes no new
    /// writes except from commands that already hold a liveness lease, so
    /// recent trace or snapshot activity does not keep it.
    pub ended_only: bool,
    pub older_than: Option<Duration>,
}

#[derive(Debug)]
pub struct GcReport {
    pub removed: Vec<String>,
}

pub fn is_live(session_id: &str) -> Result<bool, AppError> {
    is_live_by(session_id, true)
}

fn is_live_by(session_id: &str, activity_counts: bool) -> Result<bool, AppError> {
    validate_session_id(session_id)?;
    let store = RefStore::for_session(Some(session_id))?;
    if lock_holder_is_live(&store.base_dir().join("refstore.lock")) {
        return Ok(true);
    }
    if super::liveness::any_held(store.base_dir()) {
        return Ok(true);
    }
    if !activity_counts {
        return Ok(false);
    }
    let manifest = read_manifest(session_id)?;
    Ok(has_recent_activity(&store, manifest.as_ref()))
}

fn has_recent_activity(store: &RefStore, manifest: Option<&SessionManifest>) -> bool {
    if path_recently_modified(&store.base_dir().join("snapshots"))
        || trace_dir_recently_written(&store.trace_dir())
    {
        return true;
    }
    manifest.is_some_and(|manifest| {
        let age = Duration::from_millis(now_millis().saturating_sub(manifest.created_at));
        manifest.ended_at.is_none() && age < TRACE_LIVENESS_WINDOW
    })
}

pub fn gc(options: GcOptions) -> Result<GcReport, AppError> {
    let mut removed = Vec::new();
    for manifest in list_sessions()? {
        let activity_counts = !(options.ended_only && manifest.ended_at.is_some());
        if is_live_by(&manifest.id, activity_counts)? {
            continue;
        }
        if options.ended_only && manifest.ended_at.is_none() {
            continue;
        }
        if let Some(older_than) = options.older_than {
            let age_reference = manifest.ended_at.unwrap_or(manifest.created_at);
            let age_ms = now_millis().saturating_sub(age_reference);
            if Duration::from_millis(age_ms) < older_than {
                continue;
            }
        } else if manifest.ended_at.is_none() {
            continue;
        }
        let store = RefStore::for_session(Some(&manifest.id))?;
        let dir = store.base_dir().to_path_buf();
        let lock = match RefStoreLock::acquire(&dir.join("refstore.lock")) {
            Ok(lock) => lock,
            Err(_) => continue,
        };
        if super::liveness::any_held(&dir)
            || (activity_counts && has_recent_activity(&store, Some(&manifest)))
        {
            drop(lock);
            continue;
        }
        let did_remove = remove_session_dir(&dir)?;
        drop(lock);
        if did_remove {
            removed.push(manifest.id);
        }
    }
    Ok(GcReport { removed })
}

fn path_recently_modified(path: &Path) -> bool {
    let cutoff = SystemTime::now()
        .checked_sub(TRACE_LIVENESS_WINDOW)
        .unwrap_or(UNIX_EPOCH);
    std::fs::metadata(path)
        .and_then(|metadata| metadata.modified())
        .ok()
        .is_some_and(|modified| modified >= cutoff)
}

fn trace_dir_recently_written(trace_dir: &Path) -> bool {
    let Ok(entries) = std::fs::read_dir(trace_dir) else {
        return false;
    };
    let cutoff = SystemTime::now()
        .checked_sub(TRACE_LIVENESS_WINDOW)
        .unwrap_or(UNIX_EPOCH);
    entries.flatten().any(|entry| {
        entry
            .metadata()
            .ok()
            .and_then(|metadata| metadata.modified().ok())
            .is_some_and(|modified| modified >= cutoff)
    })
}

pub(crate) fn remove_session_dir(dir: &Path) -> Result<bool, AppError> {
    if !dir.is_dir() {
        return Ok(false);
    }
    if std::fs::symlink_metadata(dir)
        .map(|meta| meta.file_type().is_symlink())
        .unwrap_or(true)
    {
        return Err(AppError::invalid_input_with_suggestion(
            "Refusing to remove a symlinked session directory",
            "Remove the symlink manually before running session gc.",
        ));
    }
    std::fs::remove_dir_all(dir)?;
    Ok(true)
}
