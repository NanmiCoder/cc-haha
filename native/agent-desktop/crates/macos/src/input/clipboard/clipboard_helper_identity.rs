use agent_desktop_core::{AdapterError, ErrorCode};
use std::ffi::{CString, c_int, c_void};
use std::os::unix::{ffi::OsStrExt, fs::MetadataExt};

use super::clipboard_helper_protocol as protocol;
use super::directory_identity::DirectoryIdentity;

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct HelperIdentity {
    pub(crate) path: std::path::PathBuf,
    device: u64,
    inode: u64,
    owner: u32,
    mode: u32,
    links: u64,
    ancestors: Vec<DirectoryIdentity>,
}

impl HelperIdentity {
    pub(crate) fn discover() -> Result<Self, AdapterError> {
        if let Some(path) = std::env::var_os("AGENT_DESKTOP_MACOS_HELPER_PATH") {
            let path = std::path::PathBuf::from(path);
            if !path.is_absolute() {
                return Err(invalid("Explicit helper path must be absolute"));
            }
            return Self::read(path);
        }
        let mut candidates = Vec::new();
        if let Ok(executable) = std::env::current_exe()
            && let Some(parent) = executable.parent()
        {
            candidates.push(parent.join(protocol::HELPER_BASENAME));
        }
        if let Some(image) = super::clipboard_helper_dl::containing_image()
            && let Some(parent) = image.parent()
        {
            let candidate = parent.join(protocol::HELPER_BASENAME);
            if !candidates.contains(&candidate) {
                candidates.push(candidate);
            }
        }
        for candidate in candidates {
            match Self::read(candidate) {
                Ok(identity) => return Ok(identity),
                Err(error) if missing(&error) => {}
                Err(error) => return Err(error),
            }
        }
        Err(invalid("No colocated packaged helper was found"))
    }

    pub(crate) fn revalidate(&self) -> Result<(), AdapterError> {
        let current = Self::read(self.path.clone())?;
        if current == *self {
            Ok(())
        } else {
            Err(invalid("Helper filesystem identity changed during launch"))
        }
    }

    fn read(path: std::path::PathBuf) -> Result<Self, AdapterError> {
        if path.file_name().and_then(|name| name.to_str()) != Some(protocol::HELPER_BASENAME) {
            return Err(invalid("Helper path has the wrong packaged basename"));
        }
        let original = std::fs::symlink_metadata(&path).map_err(|error| {
            invalid_with_kind(
                format!("{}: {error}", path.display()),
                if error.kind() == std::io::ErrorKind::NotFound {
                    "clipboard_helper_not_found"
                } else {
                    "clipboard_helper_invalid"
                },
            )
        })?;
        if !original.file_type().is_file() {
            return Err(invalid("Helper must be a regular file, not a symlink"));
        }
        let path = path.canonicalize().map_err(|error| {
            invalid_with_kind(
                format!("{}: {error}", path.display()),
                "clipboard_helper_invalid",
            )
        })?;
        let metadata = std::fs::symlink_metadata(&path).map_err(|error| {
            invalid_with_kind(
                format!("{}: {error}", path.display()),
                "clipboard_helper_invalid",
            )
        })?;
        let mode = metadata.mode();
        if !metadata.file_type().is_file()
            || metadata.uid() != unsafe { libc::geteuid() }
            || mode & 0o022 != 0
            || mode & 0o111 == 0
            || metadata.nlink() != 1
        {
            return Err(invalid(
                "Helper must be an owner-matched, executable, single-link regular file with no group/world writes",
            ));
        }
        if acl_has_mutating_allow(&path)
            .map_err(|error| invalid(format!("Could not verify helper ACL: {error}")))?
        {
            return Err(invalid("Helper ACL permits another principal to modify it"));
        }
        let mut ancestors = Vec::new();
        let parent = path
            .parent()
            .ok_or_else(|| invalid("Helper has no parent directory"))?;
        for directory in parent.ancestors() {
            let metadata = std::fs::symlink_metadata(directory).map_err(|error| {
                invalid(format!(
                    "Could not verify helper directory {}: {error}",
                    directory.display()
                ))
            })?;
            let owner = metadata.uid();
            let mode = metadata.mode();
            let sticky = mode & 0o1000 != 0;
            if !metadata.file_type().is_dir()
                || (owner != 0 && owner != unsafe { libc::geteuid() })
                || (mode & 0o022 != 0 && !sticky)
                || acl_has_mutating_allow(directory).map_err(|error| {
                    invalid(format!("Could not verify helper directory ACL: {error}"))
                })?
            {
                return Err(invalid(format!(
                    "Helper path crosses a directory writable by an untrusted principal: {}",
                    directory.display()
                )));
            }
            ancestors.push(DirectoryIdentity {
                path: directory.to_path_buf(),
                device: metadata.dev(),
                inode: metadata.ino(),
                owner,
                mode,
            });
        }
        Ok(Self {
            path,
            device: metadata.dev(),
            inode: metadata.ino(),
            owner: metadata.uid(),
            mode,
            links: metadata.nlink(),
            ancestors,
        })
    }
}

type Acl = *mut c_void;
type AclEntry = *mut c_void;
type AclPermset = *mut c_void;

const ACL_TYPE_EXTENDED: c_int = 0x100;
const ACL_FIRST_ENTRY: c_int = 0;
const ACL_NEXT_ENTRY: c_int = -1;
const ACL_EXTENDED_ALLOW: c_int = 1;
const ACL_WRITE_DATA: c_int = 1 << 2;
const ACL_DELETE: c_int = 1 << 4;
const ACL_APPEND_DATA: c_int = 1 << 5;
const ACL_DELETE_CHILD: c_int = 1 << 6;
const ACL_WRITE_ATTRIBUTES: c_int = 1 << 8;
const ACL_WRITE_EXTATTRIBUTES: c_int = 1 << 10;
const ACL_WRITE_SECURITY: c_int = 1 << 12;
const ACL_CHANGE_OWNER: c_int = 1 << 13;

#[link(name = "System")]
unsafe extern "C" {
    fn acl_get_file(path: *const std::ffi::c_char, kind: c_int) -> Acl;
    fn acl_get_entry(acl: Acl, entry_id: c_int, entry: *mut AclEntry) -> c_int;
    fn acl_get_tag_type(entry: AclEntry, tag: *mut c_int) -> c_int;
    fn acl_get_permset(entry: AclEntry, permset: *mut AclPermset) -> c_int;
    fn acl_get_perm_np(permset: AclPermset, perm: c_int) -> c_int;
    fn acl_get_qualifier(entry: AclEntry) -> *mut c_void;
    fn mbr_uid_to_uuid(uid: u32, uuid: *mut u8) -> c_int;
    fn acl_free(object: *mut c_void) -> c_int;
}

fn acl_has_mutating_allow(path: &std::path::Path) -> std::io::Result<bool> {
    let path_text = CString::new(path.as_os_str().as_bytes())
        .map_err(|_| std::io::Error::new(std::io::ErrorKind::InvalidInput, "path contains NUL"))?;
    let acl = unsafe { acl_get_file(path_text.as_ptr(), ACL_TYPE_EXTENDED) };
    if acl.is_null() {
        let error = std::io::Error::last_os_error();
        if error.raw_os_error() == Some(libc::ENOENT) && std::fs::symlink_metadata(path).is_ok() {
            return Ok(false);
        }
        return Err(error);
    }
    let result = unsafe {
        let mut entry_id = ACL_FIRST_ENTRY;
        'entries: loop {
            let mut entry = std::ptr::null_mut();
            match acl_get_entry(acl, entry_id, &mut entry) {
                0 => entry_id = ACL_NEXT_ENTRY,
                -1 if std::io::Error::last_os_error().raw_os_error() == Some(libc::EINVAL) => {
                    break Ok(false);
                }
                -1 => break Err(std::io::Error::last_os_error()),
                _ => {
                    break Err(std::io::Error::other(
                        "acl_get_entry returned an invalid status",
                    ));
                }
            }
            let mut tag = 0;
            if acl_get_tag_type(entry, &mut tag) != 0 {
                break Err(std::io::Error::last_os_error());
            }
            if tag != ACL_EXTENDED_ALLOW {
                continue;
            }
            let mut permset = std::ptr::null_mut();
            if acl_get_permset(entry, &mut permset) != 0 {
                break Err(std::io::Error::last_os_error());
            }
            let mut mutating = false;
            for permission in [
                ACL_WRITE_DATA,
                ACL_DELETE,
                ACL_APPEND_DATA,
                ACL_DELETE_CHILD,
                ACL_WRITE_ATTRIBUTES,
                ACL_WRITE_EXTATTRIBUTES,
                ACL_WRITE_SECURITY,
                ACL_CHANGE_OWNER,
            ] {
                match acl_get_perm_np(permset, permission) {
                    0 => {}
                    1 => mutating = true,
                    _ => break 'entries Err(std::io::Error::last_os_error()),
                }
            }
            if mutating {
                let qualifier = acl_get_qualifier(entry);
                if qualifier.is_null() {
                    break Err(std::io::Error::last_os_error());
                }
                let mut current_user = [0_u8; 16];
                let status = mbr_uid_to_uuid(libc::geteuid(), current_user.as_mut_ptr());
                let owned = status == 0
                    && std::slice::from_raw_parts(qualifier.cast::<u8>(), 16) == current_user;
                acl_free(qualifier);
                if status != 0 {
                    break Err(std::io::Error::from_raw_os_error(status));
                }
                if !owned {
                    break Ok(true);
                }
            }
        }
    };
    unsafe { acl_free(acl) };
    result
}

fn invalid(detail: impl Into<String>) -> AdapterError {
    invalid_with_kind(detail, "clipboard_helper_invalid")
}

fn invalid_with_kind(detail: impl Into<String>, kind: &str) -> AdapterError {
    AdapterError::new(
        ErrorCode::ActionNotSupported,
        "The packaged macOS clipboard helper is missing or invalid",
    )
    .with_platform_detail(detail)
    .with_details(serde_json::json!({
        "kind": kind,
        "helper": protocol::HELPER_BASENAME,
    }))
    .with_disposition(agent_desktop_core::DeliverySemantics::not_delivered())
}

fn missing(error: &AdapterError) -> bool {
    error
        .details
        .as_ref()
        .and_then(|details| details.get("kind"))
        .and_then(serde_json::Value::as_str)
        == Some("clipboard_helper_not_found")
}

#[cfg(test)]
#[path = "clipboard_helper_identity_tests.rs"]
mod tests;
