use std::ffi::OsStr;
use std::io::ErrorKind;
use std::path::{Path, PathBuf};

use crate::AppError;

/// Creates the session directory and its trace directory. The state root
/// holds every session's files, so it must be private before a session is
/// written into it: a root that group or other users can reach is refused
/// here exactly as it is for a snapshot.
pub(super) fn create(dir: &Path) -> Result<(), AppError> {
    prepare_root()?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::DirBuilderExt;
        std::fs::DirBuilder::new()
            .recursive(true)
            .mode(0o700)
            .create(dir)?;
        std::fs::DirBuilder::new()
            .recursive(true)
            .mode(0o700)
            .create(dir.join("trace"))?;
    }
    #[cfg(not(unix))]
    {
        crate::storage::private_file_parent::ensure_private(&dir.join("trace"))?;
    }
    Ok(())
}

fn prepare_root() -> Result<PathBuf, AppError> {
    let root = crate::storage::state_root::resolve_configured_state_root()?;
    crate::storage::private_file_parent::ensure_private(&root)
        .map_err(|error| AppError::Internal(error.to_string()))?;
    Ok(root)
}

pub(crate) fn check_storage() -> Result<(), AppError> {
    let sessions = prepare_root()?.join("sessions");
    let _sessions_pin = crate::storage::private_file_ops::with_active_ops(|ops| {
        ops.pin_private_directory(&sessions)
    })?;
    let probe = sessions.join(crate::storage::private_file_ops::temporary_file_name(
        OsStr::new("status-probe"),
    ));
    #[cfg(unix)]
    {
        use std::os::unix::fs::DirBuilderExt;
        std::fs::DirBuilder::new().mode(0o700).create(&probe)?;
    }
    #[cfg(not(unix))]
    std::fs::create_dir(&probe)?;

    let trace = probe.join("trace");
    let manifest = probe.join(crate::storage::private_file_ops::temporary_file_name(
        OsStr::new("probe-manifest"),
    ));
    let result = (|| {
        create(&probe)?;
        let bytes = b"{}";
        crate::storage::private_file::write_atomic(&manifest, bytes)?;
        if crate::storage::private_file::read_private_bounded(&manifest, 2)? != bytes {
            return Err(AppError::Internal(
                "The private session storage probe could not read back its file".into(),
            ));
        }
        Ok(())
    })();

    let cleanup = [
        std::fs::remove_file(&manifest),
        std::fs::remove_dir(&trace),
        std::fs::remove_dir(&probe),
    ];
    result?;
    for removal in cleanup {
        if let Err(error) = removal
            && error.kind() != ErrorKind::NotFound
        {
            return Err(error.into());
        }
    }
    Ok(())
}

#[cfg(all(test, unix))]
#[path = "tree_tests.rs"]
mod tests;
