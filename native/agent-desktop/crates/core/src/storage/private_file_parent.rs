use std::path::Path;

pub(crate) fn ensure_private(path: &Path) -> std::io::Result<()> {
    crate::storage::private_file_ops::with_active_ops(|ops| ops.ensure_private(path))
}

pub(crate) fn ensure_private_portable(path: &Path) -> std::io::Result<()> {
    ensure_directory_path(path)?;
    let metadata = std::fs::symlink_metadata(path)?;
    if metadata.file_type().is_symlink() || !metadata.is_dir() {
        return Err(super::private_file::permission_denied(
            "private file parent must be a real directory",
        ));
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::MetadataExt;
        if metadata.uid() != unsafe { libc::geteuid() } {
            return Err(super::private_file::permission_denied(
                "private file parent is not owned by the effective user",
            ));
        }
        if metadata.mode() & 0o077 != 0 {
            return Err(super::private_file::permission_denied(
                "private file parent is accessible by group or other users",
            ));
        }
    }
    Ok(())
}

pub(crate) fn ensure_user(path: &Path) -> std::io::Result<()> {
    ensure_directory_path(path)?;
    let metadata = std::fs::metadata(path)?;
    if !metadata.is_dir() {
        return Err(super::private_file::permission_denied(
            "user output parent must be a directory",
        ));
    }
    Ok(())
}

#[cfg(unix)]
fn ensure_directory_path(path: &Path) -> std::io::Result<()> {
    use std::os::unix::fs::{DirBuilderExt, MetadataExt};

    let mut current = std::path::PathBuf::new();
    for component in path.components() {
        match component {
            std::path::Component::CurDir => continue,
            std::path::Component::ParentDir => {
                return Err(super::private_file::invalid_input(
                    "private file parent must not contain parent traversal",
                ));
            }
            _ => current.push(component.as_os_str()),
        }
        match std::fs::symlink_metadata(&current) {
            Ok(metadata) if metadata.file_type().is_symlink() && metadata.uid() != 0 => {
                return Err(super::private_file::permission_denied(
                    "private file parent path must not contain user-controlled symlinks",
                ));
            }
            Ok(metadata) if !metadata.file_type().is_symlink() && !metadata.is_dir() => {
                return Err(super::private_file::permission_denied(
                    "private file parent path must contain only directories",
                ));
            }
            Ok(_) => {}
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                match std::fs::DirBuilder::new().mode(0o700).create(&current) {
                    Ok(()) => {}
                    Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => {}
                    Err(error) => return Err(error),
                }
                let metadata = std::fs::symlink_metadata(&current)?;
                if metadata.file_type().is_symlink() || !metadata.is_dir() {
                    return Err(super::private_file::permission_denied(
                        "private file parent creation raced with a non-directory path",
                    ));
                }
            }
            Err(error) => return Err(error),
        }
    }
    Ok(())
}

#[cfg(not(unix))]
fn ensure_directory_path(path: &Path) -> std::io::Result<()> {
    std::fs::create_dir_all(path)
}
