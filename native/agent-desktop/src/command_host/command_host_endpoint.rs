use agent_desktop_core::AppError;
use std::hash::{Hash, Hasher};
use std::os::unix::fs::{DirBuilderExt, FileTypeExt, MetadataExt};
use std::path::{Path, PathBuf};

pub(super) fn identity(session: Option<&str>) -> Result<String, AppError> {
    let executable = std::env::current_exe()?;
    let metadata = std::fs::metadata(&executable)?;
    Ok(serde_json::to_string(&serde_json::json!({
        "protocol": 1,
        "root": agent_desktop_core::session::agent_desktop_dir()?,
        "session": session,
        "executable": executable,
        "revision": [metadata.dev(), metadata.ino(), metadata.size()],
        "modified": [metadata.mtime(), metadata.mtime_nsec()],
        "helper": std::env::var_os("AGENT_DESKTOP_MACOS_HELPER_PATH"),
    }))?)
}

pub(super) fn path(identity: &str) -> Result<PathBuf, AppError> {
    let parent = std::env::temp_dir();
    match validate_directory(&parent) {
        Ok(()) => {}
        Err(AppError::Io(error)) => return Err(error.into()),
        Err(_) => {
            return Err(AppError::invalid_input(
                "Command host requires a private per-user temporary directory",
            ));
        }
    }
    let directory = parent.join(format!("agent-desktop-host-{}", unsafe { libc::geteuid() }));
    match std::fs::DirBuilder::new().mode(0o700).create(&directory) {
        Ok(()) => {}
        Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => {}
        Err(error) => return Err(error.into()),
    }
    validate_directory(&directory)?;
    let mut hash = std::collections::hash_map::DefaultHasher::new();
    identity.hash(&mut hash);
    Ok(directory.join(format!("{:016x}.sock", hash.finish())))
}

pub(super) fn validate_directory(path: &Path) -> Result<(), AppError> {
    let metadata = std::fs::symlink_metadata(path)?;
    if !metadata.is_dir()
        || metadata.file_type().is_symlink()
        || metadata.uid() != unsafe { libc::geteuid() }
        || metadata.mode() & 0o077 != 0
    {
        return Err(AppError::invalid_input(
            "Command host directory must be private to the current user",
        ));
    }
    Ok(())
}

pub(super) fn validate_socket(path: &Path) -> Result<bool, AppError> {
    let metadata = match std::fs::symlink_metadata(path) {
        Ok(metadata) => metadata,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(false),
        Err(error) => return Err(error.into()),
    };
    if !metadata.file_type().is_socket()
        || metadata.uid() != unsafe { libc::geteuid() }
        || metadata.mode() & 0o077 != 0
    {
        return Err(AppError::invalid_input(
            "Command host endpoint is not a private socket",
        ));
    }
    Ok(true)
}

#[cfg(test)]
mod tests {
    use super::super::test_dir::TestDir;
    use super::*;
    use std::os::unix::fs::PermissionsExt;
    use std::os::unix::net::UnixListener;

    fn subdirectory(root: &TestDir, name: &str) -> PathBuf {
        let path = root.path().join(name);
        std::fs::create_dir(&path).unwrap();
        path
    }

    #[test]
    fn directory_validation_rejects_every_non_private_arm() {
        let root = TestDir::new();
        let loose = subdirectory(&root, "loose");
        std::fs::set_permissions(&loose, std::fs::Permissions::from_mode(0o755)).unwrap();
        assert!(validate_directory(&loose).is_err());

        let file = loose.join("file");
        std::fs::write(&file, b"x").unwrap();
        assert!(validate_directory(&file).is_err());

        let target = subdirectory(&root, "target");
        let link = root.path().join("link");
        std::os::unix::fs::symlink(&target, &link).unwrap();
        assert!(validate_directory(&link).is_err());

        let private = subdirectory(&root, "private");
        std::fs::set_permissions(&private, std::fs::Permissions::from_mode(0o700)).unwrap();
        assert!(validate_directory(&private).is_ok());
    }

    #[test]
    fn socket_validation_rejects_non_sockets_and_loose_modes() {
        let root = TestDir::new();
        let dir = root.path();
        let missing = dir.join("missing.sock");
        assert!(!validate_socket(&missing).unwrap());

        let file = dir.join("file.sock");
        std::fs::write(&file, b"x").unwrap();
        assert!(validate_socket(&file).is_err());

        let socket = dir.join("ok.sock");
        let _listener = UnixListener::bind(&socket).unwrap();
        std::fs::set_permissions(&socket, std::fs::Permissions::from_mode(0o644)).unwrap();
        assert!(validate_socket(&socket).is_err());
        std::fs::set_permissions(&socket, std::fs::Permissions::from_mode(0o600)).unwrap();
        assert!(validate_socket(&socket).unwrap());
    }
}
