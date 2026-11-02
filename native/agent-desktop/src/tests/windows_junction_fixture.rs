use std::path::{Path, PathBuf};
use std::process::Command;

/// Shared Windows junction-fixture helpers for the private-file-install
/// behavioral tests. Single source of truth included via `#[path]` from
/// every call site — the `agent-desktop` binary's own integration test and
/// the standalone `agent-desktop-ffi` crate's integration test cannot share
/// a Rust module across a crate boundary, but they can share this file.
const FILE_ATTRIBUTE_REPARSE_POINT: u32 = 0x400;

pub(crate) fn plant_junction(link: &Path, target: &Path) {
    let output = Command::new("cmd")
        .args(["/C", "mklink", "/J"])
        .arg(link)
        .arg(target)
        .output()
        .expect("cmd /c mklink starts");
    assert!(
        output.status.success(),
        "mklink /J must succeed without privilege: {}",
        String::from_utf8_lossy(&output.stderr)
    );
    let attributes = {
        use std::os::windows::fs::MetadataExt;
        std::fs::symlink_metadata(link)
            .expect("junction link exists")
            .file_attributes()
    };
    assert!(
        attributes & FILE_ATTRIBUTE_REPARSE_POINT != 0,
        "planted link must carry FILE_ATTRIBUTE_REPARSE_POINT"
    );
}

pub(crate) fn entries_under(root: &Path) -> Vec<PathBuf> {
    let mut entries = Vec::new();
    let mut pending = vec![root.to_path_buf()];
    while let Some(directory) = pending.pop() {
        let Ok(read) = std::fs::read_dir(&directory) else {
            continue;
        };
        for entry in read.flatten() {
            let path = entry.path();
            if entry.file_type().is_ok_and(|file_type| file_type.is_dir()) {
                pending.push(path.clone());
            }
            entries.push(path);
        }
    }
    entries
}
