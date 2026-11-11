use std::fs;
use std::os::unix::fs::symlink;
use std::path::PathBuf;
use std::time::{Duration, SystemTime};

use super::*;

fn scratch(name: &str) -> PathBuf {
    use std::os::unix::fs::DirBuilderExt;

    let name = agent_desktop_core::temporary_file_name(std::ffi::OsStr::new(name));
    let dir = std::env::temp_dir().join(name);
    std::fs::DirBuilder::new()
        .mode(0o700)
        .create(&dir)
        .expect("exclusive private temporary directory");
    dir
}

fn me() -> u32 {
    rustix::process::getuid().as_raw()
}

fn long_ago() -> SystemTime {
    SystemTime::now() - Duration::from_secs(5)
}

#[test]
fn a_file_uri_decodes_to_its_path() {
    assert_eq!(
        path_of_uri("file:///tmp/a%20b.png").expect("a path"),
        PathBuf::from("/tmp/a b.png")
    );
    assert_eq!(
        path_of_uri("file://localhost/tmp/x.png").expect("a path"),
        PathBuf::from("/tmp/x.png")
    );
}

#[test]
fn other_uris_are_refused() {
    for uri in [
        "http://example.test/x.png",
        "file://other-host/tmp/x.png",
        "file:///tmp/../etc/passwd",
        "file:///tmp/a%00b.png",
        "file:///tmp/a%zz.png",
        "file://relative",
    ] {
        assert!(path_of_uri(uri).is_err(), "{uri}");
    }
}

#[test]
fn a_file_outside_the_allowed_directories_is_neither_read_nor_removed() {
    let dir = scratch("outside");
    let other = scratch("elsewhere");
    let path = dir.join("shot.png");
    fs::write(&path, b"x").expect("a file");
    assert!(take_file(&path, &[other], me(), long_ago()).is_err());
    assert!(path.exists());
}

#[test]
fn a_symlink_is_refused_and_its_target_survives() {
    let dir = scratch("link");
    let target = dir.join("target.png");
    let link = dir.join("link.png");
    fs::write(&target, b"secret").expect("a target");
    symlink(&target, &link).expect("a link");
    assert!(take_file(&link, std::slice::from_ref(&dir), me(), long_ago()).is_err());
    assert!(target.exists());
}

#[test]
fn a_file_of_another_user_is_refused_and_kept() {
    let dir = scratch("owner");
    let path = dir.join("shot.png");
    fs::write(&path, b"x").expect("a file");
    assert!(take_file(&path, std::slice::from_ref(&dir), me() + 1, long_ago()).is_err());
    assert!(path.exists());
}

#[test]
fn a_file_older_than_the_request_is_refused_and_kept() {
    let dir = scratch("stale");
    let path = dir.join("shot.png");
    fs::write(&path, b"x").expect("a file");
    let later = SystemTime::now() + Duration::from_secs(3_600);
    assert!(take_file(&path, std::slice::from_ref(&dir), me(), later).is_err());
    assert!(path.exists());
}

#[test]
fn a_directory_is_not_a_screenshot() {
    let dir = scratch("dir");
    let inner = dir.join("inner");
    fs::create_dir_all(&inner).expect("a directory");
    assert!(take_file(&inner, std::slice::from_ref(&dir), me(), long_ago()).is_err());
}

#[test]
fn a_fifo_is_refused_at_once_and_left_in_place() {
    let dir = scratch("fifo");
    let path = dir.join("shot.png");
    rustix::fs::mknodat(
        rustix::fs::CWD,
        &path,
        rustix::fs::FileType::Fifo,
        rustix::fs::Mode::from_raw_mode(0o600),
        0,
    )
    .expect("a fifo");
    let started = std::time::Instant::now();
    assert!(take_file(&path, std::slice::from_ref(&dir), me(), long_ago()).is_err());
    assert!(started.elapsed() < Duration::from_secs(2));
    assert!(path.exists());
}

#[test]
fn a_name_swapped_after_the_open_is_not_removed() {
    let dir = scratch("swap");
    let path = dir.join("shot.png");
    let other = dir.join("other.png");
    fs::write(&path, b"png bytes").expect("a file");
    fs::write(&other, b"someone else's").expect("another file");
    let directory = rustix::fs::openat(
        rustix::fs::CWD,
        &dir,
        OFlags::RDONLY | OFlags::DIRECTORY,
        Mode::empty(),
    )
    .expect("a directory");
    let opened = fs::metadata(&path).expect("metadata");
    fs::rename(&other, &path).expect("a swap");
    let name = std::ffi::OsStr::new("shot.png");
    remove_if_same(
        &directory,
        name,
        (
            std::os::unix::fs::MetadataExt::dev(&opened),
            std::os::unix::fs::MetadataExt::ino(&opened),
        ),
    );
    assert_eq!(fs::read(&path).expect("kept"), b"someone else's");
}

#[test]
fn a_file_over_the_size_cap_is_refused_and_removed() {
    let dir = scratch("big");
    let path = dir.join("shot.png");
    fs::write(&path, vec![0u8; MAX_PNG_INPUT_BYTES + 1]).expect("a file");
    assert!(take_file(&path, std::slice::from_ref(&dir), me(), long_ago()).is_err());
    assert!(!path.exists());
}

#[test]
fn repeated_fixture_names_keep_existing_contents_and_create_private_directories() {
    use std::os::unix::fs::PermissionsExt;

    let first = scratch("exclusive");
    std::fs::create_dir_all(&first).expect("first directory");
    let sentinel = first.join("sentinel");
    std::fs::write(&sentinel, b"unchanged").expect("sentinel");
    let second = scratch("exclusive");
    assert_ne!(first, second);
    assert_eq!(
        std::fs::read(sentinel).expect("preserved sentinel"),
        b"unchanged"
    );
    assert_eq!(
        std::fs::metadata(second)
            .expect("directory")
            .permissions()
            .mode()
            & 0o777,
        0o700
    );
}
