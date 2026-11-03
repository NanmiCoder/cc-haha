//! Per-component reparse-point rejection for private-file paths.
//!
//! A junction is creatable by an unprivileged user without
//! `SeCreateSymbolicLinkPrivilege`, and one planted on a private path
//! redirects where the product writes — no ACL on the intended destination
//! prevents a write that never reaches it. Every component of a write path is
//! therefore opened with `FILE_FLAG_OPEN_REPARSE_POINT` (never following the
//! link) and refused if it carries `FILE_ATTRIBUTE_REPARSE_POINT`. This is
//! the Windows analogue of the unix per-component symlink rejection in core's
//! `private_file_parent.rs`, and it restores the check the deleted v0.5.0
//! layer carried. Reads guard only the leaf, exactly as the unix baseline's
//! `O_NOFOLLOW` does.

use std::fs::{File, OpenOptions};
use std::io::ErrorKind;
use std::os::windows::fs::{MetadataExt, OpenOptionsExt};
use std::path::{Component, Path, PathBuf};

use windows_sys::Win32::Storage::FileSystem::{
    FILE_ATTRIBUTE_DIRECTORY, FILE_ATTRIBUTE_REPARSE_POINT, FILE_FLAG_BACKUP_SEMANTICS,
    FILE_FLAG_OPEN_REPARSE_POINT, FILE_LIST_DIRECTORY, FILE_READ_ATTRIBUTES, FILE_SHARE_READ,
    FILE_SHARE_WRITE, READ_CONTROL,
};

use super::dacl;
use super::owner;
use super::{invalid_input, permission_denied};

const NO_FOLLOW_DIRECTORY_FLAGS: u32 = FILE_FLAG_OPEN_REPARSE_POINT | FILE_FLAG_BACKUP_SEMANTICS;

/// Access the pin handles request. `FILE_LIST_DIRECTORY` is a read-data right,
/// and only a read/write/delete data access makes a handle participate in
/// Windows share-access enforcement: an attribute-only handle is exempt from
/// `IoCheckShareAccess`, imposes no sharing constraint, and would let a
/// DELETE/rename of the pinned directory through despite the narrowed share
/// mode. `FILE_READ_ATTRIBUTES` rides along so the same handle can verify the
/// directory attributes without a second open.
pub(super) const DIRECTORY_PIN_ACCESS: u32 = FILE_LIST_DIRECTORY | FILE_READ_ATTRIBUTES;

#[derive(Clone, Copy, PartialEq, Eq)]
enum MissingComponents {
    Create,
    Reject,
}

/// A retained no-follow handle on every directory from the root down to the
/// operation's parent. Each handle is opened without `FILE_SHARE_DELETE`, so
/// while the guard lives none of the pinned directories can be renamed or
/// deleted and none of their names can be reassigned to a junction. Holding
/// the whole chain across the create, write, and `ReplaceFileW` that follow
/// forces every later path-based re-resolution to land on the same validated
/// directories, closing the check-to-use window in which an attacker could
/// swap a validated ancestor for a junction and redirect the private write.
/// The handles are read-only ballast kept alive solely for that pin; the
/// field is intentionally never read after construction.
pub(super) struct PinnedDirectoryChain {
    _handles: Vec<File>,
    created_leaf: bool,
}

pub(super) fn ensure_private_directory_chain(path: &Path) -> std::io::Result<PinnedDirectoryChain> {
    let chain = walk_directory_components(path, MissingComponents::Create)?;
    let directory = open_directory_no_follow(
        path,
        FILE_READ_ATTRIBUTES | READ_CONTROL | windows_sys::Win32::Storage::FileSystem::WRITE_DAC,
    )?;
    require_verified_directory(&directory)?;
    owner::require_actual_owner_by_eligible_principal(&directory, "private file parent")?;
    if chain.created_leaf {
        dacl::protect_directory(&directory)?;
    }
    dacl::require_private(&directory)?;
    Ok(chain)
}

pub(super) fn require_private_directory_chain(
    path: &Path,
) -> std::io::Result<PinnedDirectoryChain> {
    let chain = walk_directory_components(path, MissingComponents::Reject)?;
    let directory = open_directory_no_follow(path, FILE_READ_ATTRIBUTES | READ_CONTROL)?;
    require_verified_directory(&directory)?;
    owner::require_actual_owner_by_eligible_principal(&directory, "private file parent")?;
    dacl::require_private(&directory)?;
    Ok(chain)
}

fn walk_directory_components(
    path: &Path,
    missing: MissingComponents,
) -> std::io::Result<PinnedDirectoryChain> {
    let mut current = PathBuf::new();
    let mut handles = Vec::new();
    let mut created_leaf = false;
    for component in path.components() {
        match component {
            Component::CurDir => continue,
            Component::ParentDir => {
                return Err(invalid_input(
                    "private file parent must not contain parent traversal",
                ));
            }
            Component::Prefix(prefix) => {
                current.push(prefix.as_os_str());
                continue;
            }
            Component::RootDir | Component::Normal(_) => current.push(component.as_os_str()),
        }
        let (handle, created) = pin_directory_component(&current, missing)?;
        handles.push(handle);
        created_leaf = created;
    }
    Ok(PinnedDirectoryChain {
        _handles: handles,
        created_leaf,
    })
}

fn pin_directory_component(
    component_path: &Path,
    missing: MissingComponents,
) -> std::io::Result<(File, bool)> {
    match open_directory_no_follow(component_path, DIRECTORY_PIN_ACCESS) {
        Ok(directory) => {
            require_verified_directory(&directory)?;
            Ok((directory, false))
        }
        Err(error)
            if error.kind() == ErrorKind::NotFound && missing == MissingComponents::Create =>
        {
            let created = create_directory_component(component_path)?;
            let directory = open_directory_no_follow(component_path, DIRECTORY_PIN_ACCESS)?;
            require_verified_directory(&directory)?;
            Ok((directory, created))
        }
        Err(error) => Err(error),
    }
}

fn create_directory_component(component_path: &Path) -> std::io::Result<bool> {
    match std::fs::create_dir(component_path) {
        Ok(()) => Ok(true),
        Err(error) if error.kind() == ErrorKind::AlreadyExists => Ok(false),
        Err(error) => Err(error),
    }
}

pub(super) fn open_directory_no_follow(path: &Path, access: u32) -> std::io::Result<File> {
    OpenOptions::new()
        .access_mode(access)
        .share_mode(FILE_SHARE_READ | FILE_SHARE_WRITE)
        .custom_flags(NO_FOLLOW_DIRECTORY_FLAGS)
        .open(path)
}

fn require_verified_directory(directory: &File) -> std::io::Result<()> {
    let attributes = handle_attributes(directory)?;
    require_not_reparse_point(attributes, "private file path component is a reparse point")?;
    if attributes & FILE_ATTRIBUTE_DIRECTORY == 0 {
        return Err(permission_denied(
            "private file path component must be a directory",
        ));
    }
    Ok(())
}

pub(super) fn open_leaf_regular_no_follow(
    path: &Path,
    options: &mut OpenOptions,
    what: &str,
) -> std::io::Result<File> {
    options.custom_flags(FILE_FLAG_OPEN_REPARSE_POINT);
    let file = options.open(path)?;
    require_regular_leaf(&file, what)?;
    Ok(file)
}

pub(super) fn open_leaf_for_validation(path: &Path, what: &str) -> std::io::Result<File> {
    let file = OpenOptions::new()
        .access_mode(FILE_READ_ATTRIBUTES | READ_CONTROL)
        .custom_flags(FILE_FLAG_OPEN_REPARSE_POINT)
        .open(path)?;
    require_regular_leaf(&file, what)?;
    Ok(file)
}

fn require_regular_leaf(file: &File, what: &str) -> std::io::Result<()> {
    let attributes = handle_attributes(file)?;
    require_not_reparse_point(attributes, format!("{what} is a reparse point"))?;
    if attributes & FILE_ATTRIBUTE_DIRECTORY != 0 {
        return Err(permission_denied(format!("{what} is not a regular file")));
    }
    Ok(())
}

pub(super) fn require_verified_lease_directory(directory: &File) -> std::io::Result<()> {
    require_verified_directory(directory)
}

fn require_not_reparse_point(attributes: u32, message: impl Into<String>) -> std::io::Result<()> {
    if attributes & FILE_ATTRIBUTE_REPARSE_POINT != 0 {
        return Err(permission_denied(message));
    }
    Ok(())
}

fn handle_attributes(file: &File) -> std::io::Result<u32> {
    Ok(file.metadata()?.file_attributes())
}
