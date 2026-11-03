use std::ffi::OsStr;
use std::io::Read;
use std::os::fd::OwnedFd;
use std::path::{Component, Path, PathBuf};
use std::time::{Duration, SystemTime};

use agent_desktop_core::{AdapterError, ErrorCode, MAX_PNG_INPUT_BYTES};
use rustix::fs::{AtFlags, CWD, FileType, Mode, OFlags, fstat, openat, statat, unlinkat};

const FRESH_FOR: Duration = Duration::from_secs(120);

fn refused(reason: &str) -> AdapterError {
    AdapterError::new(
        ErrorCode::ActionFailed,
        format!("The screenshot file the portal named was not used: {reason}"),
    )
}

fn hex(byte: u8) -> Option<u8> {
    match byte {
        b'0'..=b'9' => Some(byte - b'0'),
        b'a'..=b'f' => Some(byte - b'a' + 10),
        b'A'..=b'F' => Some(byte - b'A' + 10),
        _ => None,
    }
}

fn decode_percent(text: &str) -> Option<Vec<u8>> {
    let bytes = text.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut at = 0;
    while at < bytes.len() {
        if bytes[at] == b'%' {
            let high = hex(*bytes.get(at + 1)?)?;
            let low = hex(*bytes.get(at + 2)?)?;
            out.push(high << 4 | low);
            at += 3;
        } else {
            out.push(bytes[at]);
            at += 1;
        }
    }
    Some(out)
}

/// The absolute path a `file:` URI names. A host other than empty or
/// `localhost`, a relative path, a NUL and a `..` component are refused.
pub(crate) fn path_of_uri(uri: &str) -> Result<PathBuf, AdapterError> {
    let rest = uri
        .strip_prefix("file://")
        .ok_or_else(|| refused("it is not a file URI"))?;
    let path = rest.strip_prefix("localhost").unwrap_or(rest);
    if !path.starts_with('/') {
        return Err(refused("it names another host or a relative path"));
    }
    let bytes = decode_percent(path).ok_or_else(|| refused("its name is not valid"))?;
    if bytes.contains(&0) {
        return Err(refused("its name is not valid"));
    }
    let decoded =
        PathBuf::from(String::from_utf8(bytes).map_err(|_| refused("its name is not valid"))?);
    if decoded
        .components()
        .any(|part| part == Component::ParentDir)
    {
        return Err(refused("its name climbs out of its directory"));
    }
    Ok(decoded)
}

fn inside(path: &Path, roots: &[PathBuf]) -> bool {
    let Some(parent) = path.parent().and_then(|dir| dir.canonicalize().ok()) else {
        return false;
    };
    roots
        .iter()
        .filter_map(|root| root.canonicalize().ok())
        .any(|root| parent.starts_with(root))
}

fn remove_if_same(directory: &OwnedFd, name: &OsStr, opened: (u64, u64)) {
    let Ok(now) = statat(directory, name, AtFlags::SYMLINK_NOFOLLOW) else {
        return;
    };
    if (now.st_dev, now.st_ino) == opened {
        let _ = unlinkat(directory, name, AtFlags::empty());
    }
}

/// Opens the named file without following a link, checks that it is a regular
/// file of this user, made just now and within the size cap, reads it into
/// memory and removes it. The file goes whatever the bytes turn out to be.
pub(crate) fn take_file(
    path: &Path,
    roots: &[PathBuf],
    uid: u32,
    not_before: SystemTime,
) -> Result<Vec<u8>, AdapterError> {
    if !inside(path, roots) {
        return Err(refused("it is outside the user's own directories"));
    }
    let (parent, name) = path
        .parent()
        .zip(path.file_name())
        .ok_or_else(|| refused("it could not be opened"))?;
    let directory: OwnedFd = openat(
        CWD,
        parent,
        OFlags::RDONLY | OFlags::DIRECTORY | OFlags::CLOEXEC,
        Mode::empty(),
    )
    .map_err(|_| refused("its directory could not be opened"))?;
    let fd: OwnedFd = openat(
        &directory,
        name,
        OFlags::RDONLY | OFlags::NOFOLLOW | OFlags::NONBLOCK | OFlags::CLOEXEC,
        Mode::empty(),
    )
    .map_err(|_| refused("it could not be opened"))?;
    let stat = fstat(&fd).map_err(|_| refused("it could not be inspected"))?;
    if FileType::from_raw_mode(stat.st_mode) != FileType::RegularFile {
        return Err(refused("it is not a regular file"));
    }
    if stat.st_uid != uid {
        return Err(refused("it belongs to another user"));
    }
    let modified =
        SystemTime::UNIX_EPOCH + Duration::from_secs(u64::try_from(stat.st_mtime).unwrap_or(0));
    if modified + FRESH_FOR < not_before {
        return Err(refused("it was not made for this request"));
    }
    let mut bytes = Vec::new();
    let read = std::fs::File::from(fd)
        .take(MAX_PNG_INPUT_BYTES as u64 + 1)
        .read_to_end(&mut bytes);
    remove_if_same(&directory, name, (stat.st_dev, stat.st_ino));
    read.map_err(|_| refused("it could not be read"))?;
    if bytes.len() > MAX_PNG_INPUT_BYTES {
        return Err(refused("it is larger than the size limit"));
    }
    Ok(bytes)
}

#[cfg(test)]
#[path = "wayland_file_tests.rs"]
mod tests;
