use super::*;
use std::os::unix::fs::PermissionsExt;

fn scratch(label: &str) -> std::path::PathBuf {
    let dir = std::env::temp_dir().join(format!("owner-files-{label}-{}", std::process::id()));
    let _ = fs::remove_dir_all(&dir);
    dir
}

#[test]
fn a_record_is_created_0600_in_a_0700_directory() {
    let dir = scratch("modes");
    ensure_private_dir(&dir).expect("private dir");
    write_new(&dir, "owner.json", b"{}").expect("record");
    let dir_mode = fs::metadata(&dir).expect("dir").permissions().mode() & 0o777;
    let file_mode = fs::metadata(dir.join("owner.json"))
        .expect("file")
        .permissions()
        .mode()
        & 0o777;
    assert_eq!(dir_mode, 0o700);
    assert_eq!(file_mode, 0o600);
    fs::remove_dir_all(&dir).expect("cleanup");
}

#[test]
fn an_existing_file_is_refused_and_left_alone() {
    let dir = scratch("exists");
    ensure_private_dir(&dir).expect("private dir");
    write_new(&dir, "owner.json", b"first").expect("record");
    let error = write_new(&dir, "owner.json", b"second").expect_err("exists");
    assert_eq!(error.kind(), io::ErrorKind::AlreadyExists);
    assert_eq!(fs::read(dir.join("owner.json")).expect("read"), b"first");
    fs::remove_dir_all(&dir).expect("cleanup");
}

#[test]
fn no_temporary_file_is_left_behind() {
    let dir = scratch("tmp");
    ensure_private_dir(&dir).expect("private dir");
    write_new(&dir, "owner.json", b"x").expect("record");
    let _ = write_new(&dir, "owner.json", b"y");
    let names: Vec<_> = fs::read_dir(&dir)
        .expect("list")
        .map(|entry| entry.expect("entry").file_name())
        .collect();
    assert_eq!(names, ["owner.json"]);
    fs::remove_dir_all(&dir).expect("cleanup");
}

#[test]
fn a_directory_others_can_enter_is_refused() {
    let dir = scratch("open");
    fs::create_dir_all(&dir).expect("create");
    fs::set_permissions(&dir, fs::Permissions::from_mode(0o755)).expect("chmod");
    let error = ensure_private_dir(&dir).expect_err("open directory");
    assert_eq!(error.kind(), io::ErrorKind::PermissionDenied);
    fs::remove_dir_all(&dir).expect("cleanup");
}

#[test]
fn removing_a_missing_file_is_not_an_error() {
    let dir = scratch("remove");
    ensure_private_dir(&dir).expect("private dir");
    remove(&dir, "absent.json").expect("absent");
    write_new(&dir, "present.json", b"x").expect("record");
    remove(&dir, "present.json").expect("present");
    assert!(!dir.join("present.json").exists());
    fs::remove_dir_all(&dir).expect("cleanup");
}
