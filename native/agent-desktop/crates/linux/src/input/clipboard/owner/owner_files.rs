use rustix::fs::{AtFlags, CWD, Dir, FileType, Mode, OFlags, fstat, openat, unlinkat};
use std::fs::{self, DirBuilder, File, OpenOptions};
use std::io::{self, Read, Write};
use std::os::fd::OwnedFd;
use std::os::unix::ffi::OsStrExt;
use std::os::unix::fs::{DirBuilderExt, MetadataExt, OpenOptionsExt, PermissionsExt};
use std::path::Path;

const PRIVATE_DIR_MODE: u32 = 0o700;
const PRIVATE_FILE_MODE: u32 = 0o600;
pub(crate) const MAX_RECORD_BYTES: usize = 16 * 1024;
const MAX_RECORD_COUNT: usize = 256;
const MAX_RECORD_SET_BYTES: usize = 1024 * 1024;

fn open_private_dir(dir: &Path) -> io::Result<OwnedFd> {
    let descriptor = openat(
        CWD,
        dir,
        OFlags::RDONLY | OFlags::DIRECTORY | OFlags::NOFOLLOW | OFlags::CLOEXEC,
        Mode::empty(),
    )?;
    let metadata = fstat(&descriptor)?;
    if FileType::from_raw_mode(metadata.st_mode) != FileType::Directory
        || metadata.st_uid != rustix::process::getuid().as_raw()
        || metadata.st_mode & 0o077 != 0
    {
        return Err(io::Error::new(
            io::ErrorKind::PermissionDenied,
            "the clipboard state directory is not private to this user",
        ));
    }
    Ok(descriptor)
}

fn read_file_at(directory: &OwnedFd, name: &std::ffi::OsStr) -> io::Result<Vec<u8>> {
    let descriptor = openat(
        directory,
        name,
        OFlags::RDONLY | OFlags::NOFOLLOW | OFlags::NONBLOCK | OFlags::CLOEXEC,
        Mode::empty(),
    )?;
    let metadata = fstat(&descriptor)?;
    if FileType::from_raw_mode(metadata.st_mode) != FileType::RegularFile
        || metadata.st_uid != rustix::process::getuid().as_raw()
    {
        return Err(io::Error::new(
            io::ErrorKind::InvalidData,
            "the clipboard owner record is not a regular file owned by this user",
        ));
    }
    if metadata.st_size < 0 || metadata.st_size as usize > MAX_RECORD_BYTES {
        return Err(io::Error::new(
            io::ErrorKind::InvalidData,
            "the clipboard owner record exceeds the size limit",
        ));
    }
    let mut bytes = Vec::new();
    File::from(descriptor)
        .take(MAX_RECORD_BYTES as u64 + 1)
        .read_to_end(&mut bytes)?;
    if bytes.len() > MAX_RECORD_BYTES {
        return Err(io::Error::new(
            io::ErrorKind::InvalidData,
            "the clipboard owner record exceeds the size limit",
        ));
    }
    Ok(bytes)
}

pub(crate) fn read_named(dir: &Path, name: &str) -> io::Result<Vec<u8>> {
    let directory = open_private_dir(dir)?;
    read_file_at(&directory, std::ffi::OsStr::new(name))
}

pub(crate) fn read_matching(
    dir: &Path,
    prefix: &str,
    suffix: &str,
    deadline: agent_desktop_core::Deadline,
    mut retain: impl FnMut(&[u8]) -> bool,
) -> io::Result<Vec<Vec<u8>>> {
    let directory = match open_private_dir(dir) {
        Ok(directory) => directory,
        Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(Vec::new()),
        Err(error) => return Err(error),
    };
    let mut entries = Dir::read_from(&directory)?;
    let mut records = Vec::new();
    let mut total_bytes: usize = 0;
    while let Some(entry) = entries.read() {
        deadline.ensure_remaining().map_err(|_| {
            io::Error::new(io::ErrorKind::TimedOut, "clipboard record scan timed out")
        })?;
        let entry = entry?;
        let name = entry.file_name();
        let bytes = name.to_bytes();
        if bytes.starts_with(prefix.as_bytes()) && bytes.ends_with(suffix.as_bytes()) {
            let name = std::ffi::OsStr::from_bytes(bytes);
            match read_file_at(&directory, name) {
                Ok(record) => {
                    if !retain(&record) {
                        continue;
                    }
                    if records.len() >= MAX_RECORD_COUNT {
                        return Err(io::Error::new(
                            io::ErrorKind::InvalidData,
                            "the clipboard owner record count exceeds the limit",
                        ));
                    }
                    total_bytes = total_bytes.checked_add(record.len()).ok_or_else(|| {
                        io::Error::new(
                            io::ErrorKind::InvalidData,
                            "the clipboard owner records exceed the size limit",
                        )
                    })?;
                    if total_bytes > MAX_RECORD_SET_BYTES {
                        return Err(io::Error::new(
                            io::ErrorKind::InvalidData,
                            "the clipboard owner records exceed the size limit",
                        ));
                    }
                    records.push(record);
                }
                Err(error) if error.kind() == io::ErrorKind::NotFound => {}
                Err(error) => return Err(error),
            }
        }
    }
    Ok(records)
}

/// Creates `dir` with mode 0700, or accepts an existing one only when this
/// user owns it and no one else can enter it.
pub(crate) fn ensure_private_dir(dir: &Path) -> io::Result<()> {
    DirBuilder::new()
        .recursive(true)
        .mode(PRIVATE_DIR_MODE)
        .create(dir)?;
    let metadata = fs::metadata(dir)?;
    let private = metadata.is_dir()
        && metadata.uid() == rustix::process::getuid().as_raw()
        && metadata.permissions().mode() & 0o077 == 0;
    if private {
        Ok(())
    } else {
        Err(io::Error::new(
            io::ErrorKind::PermissionDenied,
            "the clipboard state directory is not private to this user",
        ))
    }
}

/// Writes `name` in `dir` as a new 0600 file. The bytes go to a temporary
/// file first and reach the final name by a hard link, so a reader never
/// sees a partial record and an existing file is never replaced.
pub(crate) fn write_new(dir: &Path, name: &str, bytes: &[u8]) -> io::Result<()> {
    let temporary = dir.join(format!(".{name}.tmp"));
    let mut file = OpenOptions::new()
        .write(true)
        .create_new(true)
        .mode(PRIVATE_FILE_MODE)
        .open(&temporary)?;
    let written = file.write_all(bytes).and_then(|()| file.sync_all());
    drop(file);
    let linked = written.and_then(|()| fs::hard_link(&temporary, dir.join(name)));
    let _ = fs::remove_file(&temporary);
    linked
}

pub(crate) fn remove(dir: &Path, name: &str) -> io::Result<()> {
    let directory = match open_private_dir(dir) {
        Ok(directory) => directory,
        Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(()),
        Err(error) => return Err(error),
    };
    match unlinkat(&directory, name, AtFlags::empty()) {
        Err(rustix::io::Errno::NOENT) => Ok(()),
        Err(error) => Err(io::Error::from(error)),
        Ok(()) => Ok(()),
    }
}

#[cfg(test)]
#[path = "owner_files_tests.rs"]
mod tests;
