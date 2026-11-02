use super::{Scratch, create_junction};
use crate::system::private_file::WindowsPrivateFile;
use crate::system::private_file::path::{DIRECTORY_PIN_ACCESS, open_directory_no_follow};
use agent_desktop_core::PrivateFileOps;
use std::io::{ErrorKind, Read, Write};
use std::path::Path;
use windows_sys::Win32::Foundation::{ERROR_ACCESS_DENIED, ERROR_SHARING_VIOLATION};

#[test]
fn a_junction_component_on_the_write_path_is_refused_and_nothing_lands_at_its_target() {
    let root = Scratch::new("junction-mid");
    let elsewhere = Scratch::new("junction-elsewhere");
    let junction = root.path().join("redirect");
    create_junction(&junction, elsewhere.path());
    let destination = junction.join("nested").join("artifact.json");

    let outcome = WindowsPrivateFile::new().write_atomic(&destination, b"private bytes");

    let landed = elsewhere.path().join("nested").join("artifact.json");
    assert!(
        outcome.is_err(),
        "a write through a junction component must be refused"
    );
    assert!(
        !landed.exists(),
        "no artifact may land at the junction target"
    );
    assert!(
        !elsewhere.path().join("nested").exists(),
        "no directory may be created at the junction target"
    );
}

#[test]
fn a_junction_as_the_immediate_parent_is_refused_and_nothing_lands_at_its_target() {
    let root = Scratch::new("junction-parent");
    let elsewhere = Scratch::new("junction-parent-elsewhere");
    let junction = root.path().join("redirect");
    create_junction(&junction, elsewhere.path());
    let destination = junction.join("artifact.json");

    let outcome = WindowsPrivateFile::new().write_atomic(&destination, b"private bytes");

    assert!(
        outcome.is_err(),
        "a write whose parent is a junction must be refused"
    );
    assert!(
        !elsewhere.path().join("artifact.json").exists(),
        "no artifact may land at the junction target"
    );
}

#[test]
fn a_junction_leaf_is_refused_for_private_opens() {
    let root = Scratch::new("junction-leaf");
    let elsewhere = Scratch::new("junction-leaf-elsewhere");
    let junction = root.path().join("redirect");
    create_junction(&junction, elsewhere.path());
    let ops = WindowsPrivateFile::new();

    assert!(ops.read_private_bounded(&junction, 1024).is_err());
    assert!(ops.open_private_append(&junction).is_err());
    assert!(ops.open_private_lock(&junction, false).is_err());
}

#[test]
fn a_regular_file_where_a_directory_is_expected_is_refused() {
    let root = Scratch::new("file-component");
    let blocking_file = root.path().join("blocking.txt");
    std::fs::write(&blocking_file, b"a file, not a directory").unwrap();
    let destination = blocking_file.join("artifact.json");

    let outcome = WindowsPrivateFile::new().write_atomic(&destination, b"private bytes");

    assert!(
        outcome.is_err(),
        "a path component that is a regular file must be refused"
    );
    assert_eq!(
        std::fs::read(&blocking_file).unwrap(),
        b"a file, not a directory",
        "the blocking file must be left untouched"
    );
}

#[test]
fn a_directory_destination_is_refused_for_atomic_writes() {
    let root = Scratch::new("dir-destination");
    let destination = root.path().join("already-a-directory");
    std::fs::create_dir(&destination).unwrap();

    let outcome = WindowsPrivateFile::new().write_atomic(&destination, b"private bytes");

    assert!(outcome.is_err());
    assert!(destination.is_dir(), "the directory must be left untouched");
}

#[test]
fn ensure_private_creates_a_nested_chain_that_accepts_writes() {
    let root = Scratch::new("ensure-nested");
    let nested = root.path().join("sessions").join("s1").join("trace");
    let ops = WindowsPrivateFile::new();

    ops.ensure_private(&nested).unwrap();
    assert!(nested.is_dir());

    let artifact = nested.join("segment.jsonl");
    ops.write_atomic(&artifact, b"{\"event\":1}").unwrap();
    let directory = open_directory_no_follow(
        &nested,
        DIRECTORY_PIN_ACCESS | windows_sys::Win32::Storage::FileSystem::READ_CONTROL,
    )
    .unwrap();
    let file = std::fs::File::open(&artifact).unwrap();
    crate::system::private_file::dacl::require_private(&directory).unwrap();
    crate::system::private_file::dacl::require_private(&file).unwrap();
    assert_eq!(
        ops.read_private_bounded(&artifact, 1024).unwrap(),
        b"{\"event\":1}"
    );
}

#[test]
fn a_new_private_leaf_does_not_inherit_a_broad_users_grant() {
    let root = Scratch::new("inherited-users");
    author_container_inherit_users_ace(root.path());
    let nested = root.path().join("sessions").join("s1").join("trace");

    WindowsPrivateFile::new().ensure_private(&nested).unwrap();

    let directory = open_directory_no_follow(
        &nested,
        DIRECTORY_PIN_ACCESS | windows_sys::Win32::Storage::FileSystem::READ_CONTROL,
    )
    .unwrap();
    crate::system::private_file::dacl::require_private(&directory).unwrap();
}

#[test]
fn an_existing_private_leaf_with_a_users_grant_is_refused_without_repair() {
    let root = Scratch::new("existing-users");
    author_container_inherit_users_ace(root.path());
    let nested = root.path().join("existing");
    std::fs::create_dir(&nested).unwrap();
    let before = open_directory_no_follow(
        &nested,
        DIRECTORY_PIN_ACCESS | windows_sys::Win32::Storage::FileSystem::READ_CONTROL,
    )
    .unwrap();
    assert!(crate::system::private_file::dacl::require_private(&before).is_err());

    let error = WindowsPrivateFile::new()
        .ensure_private(&nested)
        .expect_err("an unsafe existing leaf must fail closed");

    assert_eq!(error.kind(), std::io::ErrorKind::PermissionDenied);
    let after = open_directory_no_follow(
        &nested,
        DIRECTORY_PIN_ACCESS | windows_sys::Win32::Storage::FileSystem::READ_CONTROL,
    )
    .unwrap();
    assert!(crate::system::private_file::dacl::require_private(&after).is_err());
}

fn author_container_inherit_users_ace(root: &Path) {
    let status = std::process::Command::new("icacls")
        .arg(root)
        .args(["/grant", "*S-1-5-32-545:(OI)(CI)(W)"])
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .status()
        .expect("icacls must spawn to install a BUILTIN\\Users ACE");
    assert!(status.success(), "icacls must install the broad ACE");
}

#[test]
fn write_read_roundtrip_preserves_bytes_and_enforces_read_limits() {
    let root = Scratch::new("roundtrip");
    let artifact = root.path().join("refmap.json");
    let ops = WindowsPrivateFile::new();

    ops.write_atomic(&artifact, b"twelve bytes").unwrap();

    assert_eq!(
        ops.read_private_bounded(&artifact, 12).unwrap(),
        b"twelve bytes"
    );
    let over_limit = ops.read_private_bounded(&artifact, 11).unwrap_err();
    assert_eq!(over_limit.kind(), ErrorKind::InvalidData);
    let missing = ops
        .read_private_bounded(&root.path().join("absent.json"), 64)
        .unwrap_err();
    assert_eq!(missing.kind(), ErrorKind::NotFound);
}

#[test]
fn overwriting_an_existing_destination_replaces_its_content() {
    let root = Scratch::new("overwrite");
    let artifact = root.path().join("latest.json");
    let ops = WindowsPrivateFile::new();

    ops.write_atomic(&artifact, b"first").unwrap();
    ops.write_atomic(&artifact, b"second").unwrap();

    assert_eq!(ops.read_private_bounded(&artifact, 64).unwrap(), b"second");
}

#[test]
fn append_opens_create_then_grow_the_file_with_a_readable_handle() {
    let root = Scratch::new("append");
    let segment = root.path().join("trace.jsonl");
    let ops = WindowsPrivateFile::new();

    let mut first = ops.open_private_append(&segment).unwrap();
    first.write_all(b"one\n").unwrap();
    drop(first);
    let mut second = ops.open_private_append(&segment).unwrap();
    second.write_all(b"two\n").unwrap();

    let mut readable_probe = String::new();
    (&second)
        .read_to_string(&mut readable_probe)
        .expect("the append handle must grant read access so it stays lockable");
    drop(second);
    assert_eq!(
        ops.read_private_bounded(&segment, 64).unwrap(),
        b"one\ntwo\n"
    );
}

#[test]
fn lock_opens_honor_the_create_flag() {
    let root = Scratch::new("lock");
    let lock_path = root.path().join("cli.lock");
    let ops = WindowsPrivateFile::new();

    let missing = ops.open_private_lock(&lock_path, false).unwrap_err();
    assert_eq!(missing.kind(), ErrorKind::NotFound);

    drop(ops.open_private_lock(&lock_path, true).unwrap());
    assert!(lock_path.is_file());
    drop(ops.open_private_lock(&lock_path, false).unwrap());
}

#[test]
fn parent_traversal_components_are_rejected() {
    let root = Scratch::new("traversal");
    let sneaky = root.path().join("..").join("outside").join("artifact.json");

    let outcome = WindowsPrivateFile::new().write_atomic(&sneaky, b"private bytes");

    let refused = outcome.unwrap_err();
    assert_eq!(refused.kind(), ErrorKind::InvalidData);
}

struct RestoreCurrentDirOnDrop(std::path::PathBuf);

impl Drop for RestoreCurrentDirOnDrop {
    fn drop(&mut self) {
        let _ = std::env::set_current_dir(&self.0);
    }
}

#[test]
fn a_leading_current_dir_component_is_skipped_and_the_write_lands_in_the_working_directory() {
    let root = Scratch::new("curdir");
    let original_working_dir =
        std::env::current_dir().expect("the current working directory must be readable");
    let _restore = RestoreCurrentDirOnDrop(original_working_dir);
    std::env::set_current_dir(root.path())
        .expect("the scratch root must be enterable as the working directory");

    let relative = Path::new(".").join("sub").join("artifact.json");
    let ops = WindowsPrivateFile::new();
    ops.write_atomic(&relative, b"payload")
        .expect("a leading current-dir component must be skipped, not rejected");

    let landed = root.path().join("sub").join("artifact.json");
    assert_eq!(ops.read_private_bounded(&landed, 64).unwrap(), b"payload");
}

#[test]
fn a_pinned_directory_cannot_be_renamed_while_its_no_follow_handle_is_held() {
    let root = Scratch::new("pin-blocks-swap");
    let victim = root.path().join("victim");
    std::fs::create_dir(&victim).expect("the victim directory must be creatable");
    let swapped_aside = root.path().join("victim-moved");

    let pin = open_directory_no_follow(&victim, DIRECTORY_PIN_ACCESS)
        .expect("the pin handle must open the validated directory the way the chain walk does");

    let blocked = std::fs::rename(&victim, &swapped_aside)
        .expect_err("a pinned ancestor must not be renamable out from under the operation");
    let code = blocked.raw_os_error();
    assert!(
        code == Some(ERROR_SHARING_VIOLATION as i32) || code == Some(ERROR_ACCESS_DENIED as i32),
        "the blocked rename must report a sharing or access violation, got {code:?}"
    );
    assert!(victim.is_dir(), "the pinned directory must stay in place");
    assert!(
        !swapped_aside.exists(),
        "no attacker-controlled name may take the pinned directory's place"
    );

    drop(pin);

    std::fs::rename(&victim, &swapped_aside).expect(
        "with the pin released the rename must succeed, proving the pin is what blocked it",
    );
    assert!(swapped_aside.is_dir(), "the released directory must move");
    assert!(
        !victim.exists(),
        "the original name must be free once unpinned"
    );
}
