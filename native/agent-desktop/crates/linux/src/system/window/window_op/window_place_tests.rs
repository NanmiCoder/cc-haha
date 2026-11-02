use std::os::unix::fs::PermissionsExt;

use super::*;

const INSTANCE: &str = "abcd1234:99";

fn place() -> Extents {
    Extents {
        x: -20,
        y: 90,
        width: 500,
        height: 380,
    }
}

fn store(name: &str) -> (PlaceStore, PathBuf) {
    use std::os::unix::fs::DirBuilderExt;

    let name = agent_desktop_core::temporary_file_name(std::ffi::OsStr::new(name));
    let dir = std::env::temp_dir().join(name);
    std::fs::DirBuilder::new()
        .mode(0o700)
        .create(&dir)
        .expect("exclusive private temporary directory");
    (PlaceStore::at(dir.clone()), dir)
}

fn everyone_lives(_pid: u32, _instance: &str) -> bool {
    true
}

#[test]
fn a_saved_place_loads_back_with_signed_coordinates() {
    let (store, dir) = store("round");
    store
        .save(0x40_0003, 99, INSTANCE, place(), &everyone_lives)
        .expect("a save");
    assert_eq!(store.load(0x40_0003, INSTANCE), Some(place()));
    let _ = std::fs::remove_dir_all(dir);
}

#[test]
fn a_reused_window_id_of_another_process_instance_never_matches() {
    let (store, dir) = store("reuse");
    store
        .save(0x40_0003, 99, INSTANCE, place(), &everyone_lives)
        .expect("a save");
    assert_eq!(store.load(0x40_0003, "ffff0000:99"), None);
    assert_eq!(store.load(0x40_0004, INSTANCE), None);
    let _ = std::fs::remove_dir_all(dir);
}

#[test]
fn a_forgotten_place_is_gone() {
    let (store, dir) = store("forget");
    store
        .save(1, 99, INSTANCE, place(), &everyone_lives)
        .expect("a save");
    store.forget(1, INSTANCE);
    assert_eq!(store.load(1, INSTANCE), None);
    let _ = std::fs::remove_dir_all(dir);
}

#[test]
fn the_directory_is_private_and_so_is_the_file() {
    let (store, dir) = store("modes");
    store
        .save(1, 99, INSTANCE, place(), &everyone_lives)
        .expect("a save");
    let mode = |path: &Path| {
        std::fs::metadata(path)
            .expect("metadata")
            .permissions()
            .mode()
            & 0o777
    };
    assert_eq!(mode(&dir), 0o700);
    assert_eq!(mode(&store.path(1, INSTANCE)), 0o600);
    let _ = std::fs::remove_dir_all(dir);
}

#[test]
fn a_save_drops_the_entries_of_processes_that_are_gone_and_keeps_the_living() {
    let (store, dir) = store("sweep");
    store
        .save(1, 11, "dead:11", place(), &everyone_lives)
        .expect("a save");
    store
        .save(2, 22, "live:22", place(), &everyone_lives)
        .expect("a save");
    let only_22 = |pid: u32, _instance: &str| pid == 22;
    store
        .save(3, 22, "live:22", place(), &only_22)
        .expect("a save");
    assert_eq!(store.load(1, "dead:11"), None);
    assert_eq!(store.load(2, "live:22"), Some(place()));
    assert_eq!(store.load(3, "live:22"), Some(place()));
    let _ = std::fs::remove_dir_all(dir);
}

#[test]
fn a_corrupt_entry_loads_as_nothing_and_is_swept() {
    let (store, dir) = store("corrupt");
    std::fs::create_dir_all(&dir).expect("a dir");
    std::fs::write(store.path(1, INSTANCE), b"not json").expect("a write");
    assert_eq!(store.load(1, INSTANCE), None);
    store
        .save(2, 99, INSTANCE, place(), &everyone_lives)
        .expect("a save");
    assert!(!store.path(1, INSTANCE).exists());
    let _ = std::fs::remove_dir_all(dir);
}

#[test]
fn a_failed_rename_leaves_no_pending_file_behind() {
    let (store, dir) = store("failed-rename");
    std::fs::create_dir_all(store.path(0x40_0003, INSTANCE)).expect("a directory in the way");
    let outcome = store.save(0x40_0003, 99, INSTANCE, place(), &everyone_lives);
    assert!(outcome.is_err());
    let leftovers: Vec<_> = std::fs::read_dir(&dir)
        .expect("the store directory")
        .flatten()
        .filter(|entry| entry.path().extension().is_some_and(|ext| ext == "tmp"))
        .collect();
    assert!(leftovers.is_empty(), "{leftovers:?}");
    let _ = std::fs::remove_dir_all(dir);
}

#[test]
fn a_stale_pending_file_is_swept_and_a_fresh_one_is_kept() {
    let (store, dir) = store("stale-pending");
    std::fs::create_dir_all(&dir).expect("a directory");
    let stale = dir.join("00000001-old.tmp");
    let fresh = dir.join("00000002-new.tmp");
    std::fs::write(&stale, b"{}").expect("a file");
    std::fs::write(&fresh, b"{}").expect("a file");
    let old = std::time::SystemTime::now() - std::time::Duration::from_secs(600);
    std::fs::File::options()
        .write(true)
        .open(&stale)
        .expect("open")
        .set_modified(old)
        .expect("a modification time");
    store
        .save(0x40_0003, 99, INSTANCE, place(), &everyone_lives)
        .expect("a save");
    assert!(!stale.exists());
    assert!(fresh.exists());
    let _ = std::fs::remove_dir_all(dir);
}

#[test]
fn repeated_fixture_names_keep_existing_contents_and_create_private_directories() {
    use std::os::unix::fs::PermissionsExt;

    let first = store("exclusive").1;
    std::fs::create_dir_all(&first).expect("first directory");
    let sentinel = first.join("sentinel");
    std::fs::write(&sentinel, b"unchanged").expect("sentinel");
    let second = store("exclusive").1;
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
