use crate::refs::refs_lock::RefStoreLock;
use crate::{
    AppError, Deadline,
    storage::private_file::{open_private_lock, read_private_bounded},
};
use std::io::Write;
use std::path::{Path, PathBuf};

pub(crate) const MAX_SESSION_BYTES: usize = 32 * 1024 * 1024;
pub(crate) const MAX_SESSION_EVENTS: usize = 100_000;
pub(crate) const MAX_DIRECTORY_ENTRIES: usize = 4_096;
const ARTIFACT_AND_LEDGER_ENTRY_RESERVE: usize = 16;
const WRITER_ENTRY_LIMIT: usize = MAX_DIRECTORY_ENTRIES - ARTIFACT_AND_LEDGER_ENTRY_RESERVE;
const LEDGER: &str = ".trace-usage.json";

pub(crate) struct TraceWriteBudget {
    directory: PathBuf,
    usage: (usize, usize, usize),
    _lock: RefStoreLock,
}

impl TraceWriteBudget {
    pub(crate) fn acquire(directory: &Path) -> Result<Self, AppError> {
        crate::trace::trace_file::ensure_trace_dir(directory)?;
        let lock = RefStoreLock::acquire_with_deadline(
            &directory.join(".trace-budget.lock"),
            Deadline::detached_after(50)?,
        )?;
        let usage = match read_private_bounded(&directory.join(LEDGER), 256) {
            Ok(bytes) => serde_json::from_slice(&bytes)?,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => initial_usage(directory)?,
            Err(error) => return Err(error.into()),
        };
        let mut budget = Self {
            directory: directory.to_path_buf(),
            usage,
            _lock: lock,
        };
        let segment = crate::trace::trace_file::segment_path_for_dir(directory);
        match segment.symlink_metadata() {
            Ok(_) => {}
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                budget.usage.2 = budget.usage.2.saturating_add(1);
                budget.persist()?;
            }
            Err(error) => return Err(error.into()),
        }
        Ok(budget)
    }

    pub(crate) fn reserve_line(&mut self, bytes: usize) -> Result<(), AppError> {
        self.usage.0 = self.usage.0.saturating_add(bytes);
        self.usage.1 = self.usage.1.saturating_add(1);
        self.persist()
    }

    fn persist(&self) -> Result<(), AppError> {
        if self.usage.0 > MAX_SESSION_BYTES
            || self.usage.1 > MAX_SESSION_EVENTS
            || self.usage.2 > WRITER_ENTRY_LIMIT
        {
            return Err(AppError::invalid_input_with_suggestion(
                "Session trace reached its reader-compatible recording limit",
                "Start a new session to continue recording; the existing trace remains readable.",
            ));
        }
        let mut ledger = open_private_lock(&self.directory.join(LEDGER), true)?;
        ledger.set_len(0)?;
        ledger.write_all(&serde_json::to_vec(&self.usage)?)?;
        ledger.sync_data()?;
        Ok(())
    }
}

fn initial_usage(directory: &Path) -> Result<(usize, usize, usize), AppError> {
    let mut bytes = 0_usize;
    let mut entries = 1_usize;
    for entry in std::fs::read_dir(directory)? {
        entries += 1;
        if entries > WRITER_ENTRY_LIMIT {
            return Err(AppError::invalid_input_with_suggestion(
                "Session trace has too many directory entries to continue recording",
                "Start a new session.",
            ));
        }
        let entry = entry?;
        if entry
            .file_name()
            .to_str()
            .and_then(crate::trace::trace_read::segment::parse_segment_filename)
            .is_some()
        {
            bytes = bytes
                .saturating_add(usize::try_from(entry.metadata()?.len()).unwrap_or(usize::MAX));
        }
    }
    let trace = crate::trace::trace_read::read_merged(
        directory,
        &crate::trace::trace_read::ReadOptions::default(),
    )?;
    if trace.warnings.iter().any(|warning| {
        matches!(
            warning.kind,
            crate::trace::trace_read::TraceWarningKind::UnreadableSegment
                | crate::trace::trace_read::TraceWarningKind::SymlinkedSegment
        )
    }) {
        return Err(AppError::invalid_input_with_suggestion(
            "Cannot initialize recording limits from an unreadable session trace",
            "Start a new session.",
        ));
    }
    Ok((bytes, trace.total_events, entries))
}
