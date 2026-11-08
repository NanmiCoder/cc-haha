use super::{MAX_SAVED_SNAPSHOTS, PRUNE_LOW_WATER, RefStore, STALE_TMP_MAX_AGE};
use crate::AppError;
use crate::refs::validate_snapshot_id;

impl RefStore {
    /// Removes orphaned `*.tmp` files left behind when a process died between
    /// the temp write and the atomic rename. Runs under the store write lock;
    /// the age threshold keeps any in-flight write from another process safe.
    #[cfg(test)]
    pub(crate) fn remove_tmp_files_older_than(&self, max_age: std::time::Duration) {
        let latest = self.latest_snapshot_id().ok().flatten().unwrap_or_default();
        self.remove_reachable_tmp_files(&latest, &self.snapshots_dir(), max_age);
    }

    /// Sweeps only the directories this save can have written. Snapshot ids are
    /// allocated once, so a directory is never rewritten and an orphan left in
    /// an older one is not reachable from here; those are collected by the
    /// exhaustive sweep that runs with eviction. Doing the exhaustive sweep on
    /// every save cost a `read_dir` per retained snapshot and dominated the
    /// save itself once the store reached its cap.
    fn remove_reachable_tmp_files(
        &self,
        latest_id: &str,
        snapshots_dir: &std::path::Path,
        max_age: std::time::Duration,
    ) {
        remove_stale_files_in_dir(&self.base_dir, max_age, is_orphaned_tmp_file);
        remove_stale_files_in_dir(snapshots_dir, max_age, is_orphaned_tmp_file);
        if latest_id.is_empty() {
            return;
        }
        remove_stale_files_in_dir(
            &snapshots_dir.join(latest_id),
            max_age,
            is_orphaned_tmp_file,
        );
    }

    /// Drops only the refmaps the trace already holds a copy of, leaving every
    /// other artifact in place. Being in `ArtifactsMode::Full` is not on its own
    /// proof that a copy exists: the artifact budget and a serialisation failure
    /// both skip a copy and report success, so a session that recorded more
    /// refmaps than the budget allows keeps snapshots whose only copy is here.
    /// Each directory is therefore removed only against its own duplicate, and
    /// the latest-snapshot pointer survives unless the snapshot it names is gone.
    pub fn discard_duplicated_ref_scaffolding(&self) {
        let snapshots = self.snapshots_dir();
        let duplicates = crate::trace::trace_artifacts::refmap_artifact_dir(&self.trace_dir());
        let Ok(entries) = std::fs::read_dir(&snapshots) else {
            return;
        };
        for entry in entries.flatten() {
            if !entry.file_type().is_ok_and(|kind| kind.is_dir()) {
                continue;
            }
            let id = entry.file_name().to_string_lossy().to_string();
            if validate_snapshot_id(&id).is_err() {
                continue;
            }
            if duplicates.join(format!("{id}.json")).is_file() {
                let _ = std::fs::remove_dir_all(entry.path());
            }
        }
        let pointer = self.base_dir.join(super::LATEST_SNAPSHOT_FILE);
        if let Ok(Some(latest)) = self.latest_snapshot_id()
            && !snapshots.join(&latest).is_dir()
        {
            let _ = std::fs::remove_file(pointer);
        }
    }

    pub(super) fn prune_old_snapshots_unlocked(&self, latest_id: &str) -> Result<(), AppError> {
        let dir = self.snapshots_dir();
        self.remove_reachable_tmp_files(latest_id, &dir, STALE_TMP_MAX_AGE);
        let Ok(entries) = std::fs::read_dir(&dir) else {
            return Ok(());
        };
        let mut retained = Vec::new();
        for entry in entries.flatten() {
            let Ok(file_type) = entry.file_type() else {
                continue;
            };
            if !file_type.is_dir() {
                continue;
            }
            let id = entry.file_name().to_string_lossy().to_string();
            if validate_snapshot_id(&id).is_err() {
                continue;
            }
            retained.push((id, entry.path()));
        }
        if retained.len() <= MAX_SAVED_SNAPSHOTS {
            return Ok(());
        }
        for (_, path) in &retained {
            remove_stale_files_in_dir(path, STALE_TMP_MAX_AGE, is_orphaned_tmp_file);
        }
        let mut dated: Vec<_> = retained
            .into_iter()
            .map(|(id, path)| {
                let modified = path
                    .metadata()
                    .and_then(|metadata| metadata.modified())
                    .unwrap_or(std::time::SystemTime::UNIX_EPOCH);
                (modified, id, path)
            })
            .collect();
        dated.sort_by(|left, right| (left.0, &left.1).cmp(&(right.0, &right.1)));
        let mut remove_count = dated.len().saturating_sub(PRUNE_LOW_WATER);
        for (_, id, path) in dated {
            if remove_count == 0 {
                break;
            }
            if id != latest_id {
                let _ = std::fs::remove_dir_all(path);
                remove_count -= 1;
            }
        }
        Ok(())
    }
}

pub(crate) fn is_orphaned_tmp_file(path: &std::path::Path) -> bool {
    path.extension().is_some_and(|ext| ext == "tmp")
}

/// Removes plain files directly under `dir` that satisfy `matches` and whose
/// mtime is at least `max_age` old. Never descends into subdirectories and
/// never removes a directory itself. Shared by refstore `*.tmp` cleanup and
/// the sessionless clipboard image sweep so both age-based prunes stay on one
/// implementation.
pub(crate) fn remove_stale_files_in_dir(
    dir: &std::path::Path,
    max_age: std::time::Duration,
    matches: impl Fn(&std::path::Path) -> bool,
) {
    let Ok(entries) = std::fs::read_dir(dir) else {
        return;
    };
    for entry in entries.flatten() {
        let path = entry.path();
        if !matches(&path) {
            continue;
        }
        let is_plain_file = entry.file_type().is_ok_and(|kind| kind.is_file());
        if !is_plain_file {
            continue;
        }
        let stale = entry
            .metadata()
            .ok()
            .and_then(|metadata| metadata.modified().ok())
            .and_then(|modified| modified.elapsed().ok())
            .is_some_and(|age| age >= max_age);
        if stale {
            let _ = std::fs::remove_file(&path);
        }
    }
}
