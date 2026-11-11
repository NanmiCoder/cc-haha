use crate::AppError;
use std::path::{Path, PathBuf};
use std::sync::OnceLock;

fn process_segment_suffix() -> &'static str {
    static SUFFIX: OnceLock<String> = OnceLock::new();
    SUFFIX.get_or_init(|| {
        let ts = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_millis())
            .unwrap_or(0);
        format!("{}-{ts}", std::process::id())
    })
}

pub(crate) fn segment_path_for_dir(dir: &Path) -> PathBuf {
    dir.join(format!("{}.jsonl", process_segment_suffix()))
}

pub(crate) fn open_segment_trace_file(dir: &Path) -> Result<std::fs::File, AppError> {
    ensure_trace_dir(dir)?;
    open_trace_file(&segment_path_for_dir(dir))
}

pub(crate) fn process_start_ms() -> u64 {
    static START_MS: OnceLock<u64> = OnceLock::new();
    *START_MS.get_or_init(|| {
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_millis() as u64)
            .unwrap_or(0)
    })
}

pub(crate) fn ensure_trace_dir(dir: &Path) -> Result<(), AppError> {
    if let Ok(meta) = std::fs::symlink_metadata(dir) {
        if meta.file_type().is_symlink() {
            return Err(AppError::invalid_input_with_suggestion(
                "Refusing to write trace segments through a symlinked trace directory",
                "Remove the symlink under the session's trace/ directory.",
            ));
        }
    }
    if dir.is_dir() {
        return Ok(());
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::DirBuilderExt;
        std::fs::DirBuilder::new()
            .recursive(true)
            .mode(0o700)
            .create(dir)?;
    }
    #[cfg(not(unix))]
    crate::storage::private_file_parent::ensure_private(dir)?;
    Ok(())
}

pub(crate) fn open_trace_file(path: &Path) -> Result<std::fs::File, AppError> {
    crate::storage::private_file::open_private_append(path).map_err(|error| {
        if error.kind() == std::io::ErrorKind::PermissionDenied {
            return AppError::invalid_input_with_suggestion(
                "Trace path must be a private user-owned regular file with one link",
                "Use a new --trace path or replace the existing unsafe file.",
            );
        }
        AppError::from(error)
    })
}
