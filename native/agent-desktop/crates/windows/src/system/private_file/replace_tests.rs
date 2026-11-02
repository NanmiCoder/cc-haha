use super::Scratch;
use crate::system::private_file::WindowsPrivateFile;
use crate::system::private_file::replace::{
    promote_temp_to_destination, replace_file_call, replace_style_failure_detail, to_wide_null,
};
use agent_desktop_core::PrivateFileOps;
use std::fs::{File, OpenOptions};
use std::io::Read;
use std::os::windows::fs::OpenOptionsExt;
use std::path::Path;
use windows_sys::Win32::Foundation::{ERROR_ACCESS_DENIED, ERROR_SHARING_VIOLATION};
use windows_sys::Win32::Storage::FileSystem::{
    FILE_SHARE_DELETE, FILE_SHARE_READ, FILE_SHARE_WRITE, MOVEFILE_REPLACE_EXISTING, MoveFileExW,
};

const SHARE_NONE: u32 = 0;
const SHARE_ALL: u32 = FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE;

fn open_reader_with_share(path: &Path, share: u32) -> File {
    OpenOptions::new()
        .read(true)
        .share_mode(share)
        .open(path)
        .expect("the holder handle must open")
}

fn move_file_call(source: &Path, destination: &Path) -> std::io::Result<()> {
    let source_wide = to_wide_null(source)?;
    let destination_wide = to_wide_null(destination)?;
    let succeeded = unsafe {
        MoveFileExW(
            source_wide.as_ptr(),
            destination_wide.as_ptr(),
            MOVEFILE_REPLACE_EXISTING,
        )
    };
    if succeeded != 0 {
        Ok(())
    } else {
        Err(std::io::Error::last_os_error())
    }
}

fn seeded_pair(scratch: &Scratch) -> (std::path::PathBuf, std::path::PathBuf) {
    let destination = scratch.path().join("destination.bin");
    let replacement = scratch.path().join("replacement.bin");
    std::fs::write(&destination, b"old bytes").unwrap();
    std::fs::write(&replacement, b"new bytes").unwrap();
    (destination, replacement)
}

#[test]
fn replace_succeeds_over_a_destination_held_with_share_delete_and_the_held_handle_reads_old_bytes()
{
    let scratch = Scratch::new("replace-share-all");
    let (destination, replacement) = seeded_pair(&scratch);
    let held = open_reader_with_share(&destination, SHARE_ALL);

    replace_file_call(&destination, &replacement)
        .expect("ReplaceFileW must succeed over a share-delete holder");

    let mut held_view = String::new();
    (&held)
        .read_to_string(&mut held_view)
        .expect("the held handle must stay readable");
    assert_eq!(
        held_view, "old bytes",
        "the held handle must still read the old bytes"
    );
    assert_eq!(
        std::fs::read(&destination).unwrap(),
        b"new bytes",
        "a fresh open must observe the replacement bytes"
    );
}

#[test]
fn replace_succeeds_over_a_destination_held_with_share_delete_only() {
    let scratch = Scratch::new("replace-share-delete-only");
    let (destination, replacement) = seeded_pair(&scratch);
    let held = open_reader_with_share(&destination, FILE_SHARE_DELETE);

    replace_file_call(&destination, &replacement)
        .expect("ReplaceFileW must succeed over a delete-only-share holder");

    let mut held_view = String::new();
    (&held).read_to_string(&mut held_view).unwrap();
    assert_eq!(held_view, "old bytes");
    drop(held);
    assert_eq!(std::fs::read(&destination).unwrap(), b"new bytes");
}

#[test]
fn replace_fails_32_over_a_destination_held_without_share_delete() {
    for share in [
        SHARE_NONE,
        FILE_SHARE_READ,
        FILE_SHARE_READ | FILE_SHARE_WRITE,
    ] {
        let scratch = Scratch::new("replace-no-share-delete");
        let (destination, replacement) = seeded_pair(&scratch);
        let held = open_reader_with_share(&destination, share);

        let refused = replace_file_call(&destination, &replacement).unwrap_err();

        assert_eq!(
            refused.raw_os_error(),
            Some(ERROR_SHARING_VIOLATION as i32),
            "share mode {share:#x} must fail with ERROR_SHARING_VIOLATION"
        );
        drop(held);
        assert_eq!(
            std::fs::read(&destination).unwrap(),
            b"old bytes",
            "the destination must be untouched after the refused replace"
        );
    }
}

#[test]
fn replace_fails_32_over_an_open_source_even_with_share_delete() {
    for share in [FILE_SHARE_DELETE, SHARE_ALL] {
        let scratch = Scratch::new("replace-open-source");
        let (destination, replacement) = seeded_pair(&scratch);
        let held = open_reader_with_share(&replacement, share);

        let refused = replace_file_call(&destination, &replacement).unwrap_err();

        assert_eq!(
            refused.raw_os_error(),
            Some(ERROR_SHARING_VIOLATION as i32),
            "an open source must fail with ERROR_SHARING_VIOLATION even at share {share:#x}"
        );
        drop(held);
        assert_eq!(std::fs::read(&destination).unwrap(), b"old bytes");
    }
}

#[test]
fn move_file_ex_fails_5_not_32_over_an_open_target_even_at_full_share() {
    let scratch = Scratch::new("move-open-target");
    let (destination, replacement) = seeded_pair(&scratch);
    let held = open_reader_with_share(&destination, SHARE_ALL);

    let refused = move_file_call(&replacement, &destination).unwrap_err();

    assert_ne!(
        refused.raw_os_error(),
        Some(ERROR_SHARING_VIOLATION as i32),
        "move-style ops do not report the destination-side failure as a sharing violation"
    );
    assert_eq!(
        refused.raw_os_error(),
        Some(ERROR_ACCESS_DENIED as i32),
        "MoveFileExW over an open target must fail with ERROR_ACCESS_DENIED"
    );
    drop(held);
    assert_eq!(std::fs::read(&destination).unwrap(), b"old bytes");
}

/// The diagnosis is wired into the promotion, not merely available beside it.
///
/// `replace_style_failure_detail` is pinned as a formatter below, but nothing
/// asserted that a real failed promotion carries it: dropping the annotation
/// from `promote_temp_to_destination` leaves every atomic-replace failure
/// reporting a bare OS error, and the 5-vs-32 diagnosis - the thing that says
/// whether a caller is looking at a permission problem or a file someone else
/// holds open - is what an operator has to work from.
#[test]
fn a_failed_promotion_carries_the_replace_style_diagnosis_into_its_message() {
    let scratch = Scratch::new("promote-annotated");
    let (destination, replacement) = seeded_pair(&scratch);
    let held = open_reader_with_share(&replacement, FILE_SHARE_DELETE);

    assert_eq!(
        replace_file_call(&destination, &replacement)
            .unwrap_err()
            .raw_os_error(),
        Some(ERROR_SHARING_VIOLATION as i32),
        "the open source must be what fails here, so the diagnosis below is the one under test"
    );

    let refused = promote_temp_to_destination(&destination, &replacement).unwrap_err();

    let message = refused.to_string();
    assert!(
        message.contains("atomic replace failed"),
        "the promotion must annotate its failure: {message}"
    );
    assert!(
        message.contains(replace_style_failure_detail(ERROR_SHARING_VIOLATION)),
        "the annotation must carry this code's own diagnosis: {message}"
    );
    drop(held);
}

#[test]
fn error_5_and_32_classify_to_opposite_sides_for_move_and_replace_style_ops() {
    assert!(
        replace_style_failure_detail(ERROR_SHARING_VIOLATION)
            .contains("destination-side signature for replace-style")
    );
    assert!(replace_style_failure_detail(ERROR_ACCESS_DENIED).contains("move-style"));
}

#[test]
fn write_atomic_replaces_a_destination_held_open_by_a_wide_share_reader() {
    let scratch = Scratch::new("write-over-reader");
    let destination = scratch.path().join("refmap.json");
    let ops = WindowsPrivateFile::new();
    ops.write_atomic(&destination, b"{\"v\":1}").unwrap();
    let held = open_reader_with_share(&destination, SHARE_ALL);

    ops.write_atomic(&destination, b"{\"v\":2}").unwrap();

    let mut held_view = String::new();
    (&held).read_to_string(&mut held_view).unwrap();
    assert_eq!(held_view, "{\"v\":1}");
    assert_eq!(
        ops.read_private_bounded(&destination, 64).unwrap(),
        b"{\"v\":2}"
    );
}

fn temp_lease_entries(parent: &Path) -> Vec<String> {
    std::fs::read_dir(parent)
        .unwrap()
        .flatten()
        .map(|entry| entry.file_name().to_string_lossy().into_owned())
        .filter(|name| name.starts_with(".agent-desktop-tmp-"))
        .collect()
}

#[test]
fn a_write_reclaims_an_orphan_lease_directory_no_live_writer_holds() {
    let scratch = Scratch::new("sweep-stale");
    let stale = scratch.path().join(".agent-desktop-tmp-p4294967295");
    std::fs::create_dir(&stale).unwrap();
    std::fs::write(stale.join(".orphan.tmp"), b"leftover").unwrap();
    let ops = WindowsPrivateFile::new();

    ops.write_atomic(&scratch.path().join("artifact.json"), b"fresh")
        .unwrap();

    assert!(
        !stale.exists(),
        "a lease directory with no live holder must be reclaimed"
    );
}

#[test]
fn a_lease_directory_held_without_share_delete_survives_a_concurrent_writes_sweep() {
    let scratch = Scratch::new("sweep-live");
    let foreign = scratch.path().join(".agent-desktop-tmp-p1");
    std::fs::create_dir(&foreign).unwrap();
    let liveness_handle = OpenOptions::new()
        .read(true)
        .share_mode(FILE_SHARE_READ | FILE_SHARE_WRITE)
        .custom_flags(windows_sys::Win32::Storage::FileSystem::FILE_FLAG_BACKUP_SEMANTICS)
        .open(&foreign)
        .unwrap();
    let ops = WindowsPrivateFile::new();

    ops.write_atomic(&scratch.path().join("artifact.json"), b"fresh")
        .unwrap();

    assert!(
        foreign.is_dir(),
        "a lease directory whose liveness handle is held must not be reclaimed"
    );
    drop(liveness_handle);
}

#[test]
fn a_successful_write_consumes_its_temporary_and_its_lease_directory() {
    let scratch = Scratch::new("temp-confinement");
    let ops = WindowsPrivateFile::new();

    ops.write_atomic(&scratch.path().join("artifact.json"), b"payload")
        .unwrap();

    let siblings: Vec<String> = std::fs::read_dir(scratch.path())
        .unwrap()
        .flatten()
        .map(|entry| entry.file_name().to_string_lossy().into_owned())
        .collect();
    assert_eq!(
        siblings,
        vec!["artifact.json"],
        "temporaries must live inside the lease directory and both must be consumed"
    );
}

#[test]
fn write_atomic_leaves_no_temp_lease_residue_on_success_or_failure() {
    let scratch = Scratch::new("no-residue");
    let destination = scratch.path().join("artifact.json");
    let ops = WindowsPrivateFile::new();

    ops.write_atomic(&destination, b"first").unwrap();
    assert_eq!(
        temp_lease_entries(scratch.path()),
        Vec::<String>::new(),
        "a successful write must leave no .agent-desktop-tmp-* residue"
    );

    let held = open_reader_with_share(&destination, FILE_SHARE_READ);
    ops.write_atomic(&destination, b"second")
        .expect_err("promotion over a no-share-delete holder must fail");
    drop(held);
    assert_eq!(
        temp_lease_entries(scratch.path()),
        Vec::<String>::new(),
        "a failed write must leave no .agent-desktop-tmp-* residue"
    );
    assert_eq!(std::fs::read(&destination).unwrap(), b"first");
}

#[test]
fn two_concurrent_writers_to_the_same_parent_both_succeed_with_their_final_content() {
    let scratch = Scratch::new("concurrent-writers");
    let iterations = 64_usize;

    let parent_a = scratch.path().to_path_buf();
    let writer_a = std::thread::spawn(move || {
        let ops = WindowsPrivateFile::new();
        for iteration in 0..iterations {
            let content = format!("a-{iteration}");
            ops.write_atomic(&parent_a.join("a.json"), content.as_bytes())
                .unwrap_or_else(|error| {
                    panic!("writer a iteration {iteration} must succeed: {error}")
                });
        }
    });

    let parent_b = scratch.path().to_path_buf();
    let writer_b = std::thread::spawn(move || {
        let ops = WindowsPrivateFile::new();
        for iteration in 0..iterations {
            let content = format!("b-{iteration}");
            ops.write_atomic(&parent_b.join("b.json"), content.as_bytes())
                .unwrap_or_else(|error| {
                    panic!("writer b iteration {iteration} must succeed: {error}")
                });
        }
    });

    writer_a.join().expect("writer a must not panic");
    writer_b.join().expect("writer b must not panic");

    let ops = WindowsPrivateFile::new();
    assert_eq!(
        ops.read_private_bounded(&scratch.path().join("a.json"), 64)
            .unwrap(),
        format!("a-{}", iterations - 1).into_bytes(),
        "writer a's final content must survive the concurrent writes"
    );
    assert_eq!(
        ops.read_private_bounded(&scratch.path().join("b.json"), 64)
            .unwrap(),
        format!("b-{}", iterations - 1).into_bytes(),
        "writer b's final content must survive the concurrent writes"
    );
}
