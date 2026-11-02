use std::fs;
use std::io::Write;
use std::os::unix::fs::PermissionsExt;
use std::path::Path;
use std::process::{Command, Stdio};

/// Writes an executable script through a short-lived `sh`, so the write
/// descriptor never exists in this process. A thread of this process that
/// forks while it holds one lets its child keep the file open for writing
/// until that child execs, and an exec of the script in that window fails
/// with `ETXTBSY`.
pub(crate) fn write_executable(path: &Path, content: &str) {
    let mut writer = Command::new("/bin/sh")
        .arg("-c")
        .arg("cat > \"$1\"")
        .arg("sh")
        .arg(path)
        .stdin(Stdio::piped())
        .spawn()
        .expect("the script writer starts");
    writer
        .stdin
        .take()
        .expect("a pipe")
        .write_all(content.as_bytes())
        .expect("the script is written");
    assert!(writer.wait().expect("the writer ends").success());
    fs::set_permissions(path, fs::Permissions::from_mode(0o755)).expect("executable");
}
