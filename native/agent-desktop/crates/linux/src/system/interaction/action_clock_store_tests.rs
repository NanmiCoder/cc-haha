use std::os::unix::fs::PermissionsExt;
use std::path::PathBuf;

use super::{is_fresh, recent_in, record_in};

const WINDOW: u64 = 2_000;

fn scratch(label: &str) -> PathBuf {
    let dir = std::env::temp_dir().join(format!("l311-clock-{label}-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&dir);
    dir
}

fn token(pid: u32) -> Option<String> {
    Some(format!("boot:{pid}"))
}

#[test]
fn an_action_just_recorded_is_recent_for_its_process_only() {
    let dir = scratch("recent");
    record_in(&dir, 7, 10_000, &token);
    assert!(recent_in(&dir, 7, 10_500, WINDOW, &token));
    assert!(!recent_in(&dir, 8, 10_500, WINDOW, &token));
    let _ = std::fs::remove_dir_all(&dir);
}

#[test]
fn an_entry_older_than_the_window_is_not_recent() {
    let dir = scratch("expired");
    record_in(&dir, 7, 10_000, &token);
    assert!(!recent_in(&dir, 7, 10_000 + WINDOW, WINDOW, &token));
    let _ = std::fs::remove_dir_all(&dir);
}

#[test]
fn a_reused_process_id_does_not_match_the_entry_of_the_process_before_it() {
    let dir = scratch("reuse");
    record_in(&dir, 7, 10_000, &token);
    let reused = |_: u32| Some("boot:other".to_owned());
    assert!(!recent_in(&dir, 7, 10_500, WINDOW, &reused));
    let _ = std::fs::remove_dir_all(&dir);
}

#[test]
fn an_unreadable_or_garbled_entry_is_no_recent_action() {
    let dir = scratch("garbled");
    std::fs::create_dir_all(&dir).expect("dir");
    std::fs::write(dir.join("7"), "not a record").expect("write");
    assert!(!recent_in(&dir, 7, 10_000, WINDOW, &token));
    assert!(!recent_in(&dir.join("missing"), 7, 10_000, WINDOW, &token));
    let _ = std::fs::remove_dir_all(&dir);
}

#[test]
fn an_entry_from_a_later_boot_clock_is_not_recent() {
    assert!(!is_fresh(50_000, 1_000, WINDOW));
    assert!(is_fresh(1_000, 1_500, WINDOW));
}

#[test]
fn the_store_is_private_and_a_write_prunes_what_is_gone_or_old() {
    let dir = scratch("private");
    record_in(&dir, 7, 10_000, &token);
    record_in(&dir, 9, 10_100, &token);
    let mode = |path: &PathBuf| std::fs::metadata(path).expect("meta").permissions().mode() & 0o777;
    assert_eq!(mode(&dir), 0o700);
    assert_eq!(mode(&dir.join("7")), 0o600);
    let only_nine = |pid: u32| (pid == 9).then(|| "boot:9".to_owned());
    record_in(&dir, 11, 10_200, &only_nine);
    assert!(!dir.join("7").exists(), "an entry of a process that left");
    assert!(dir.join("9").exists());
    record_in(&dir, 11, 10_200 + 120_000, &only_nine);
    assert!(!dir.join("9").exists(), "an entry past the keep time");
    let _ = std::fs::remove_dir_all(&dir);
}

#[test]
fn a_scratch_file_being_written_by_another_invocation_is_not_pruned() {
    let dir = scratch("scratch");
    std::fs::create_dir_all(&dir).expect("dir");
    std::fs::write(dir.join("7.tmp"), "").expect("scratch");
    record_in(&dir, 5, 10_000, &token);
    assert!(dir.join("7.tmp").exists());
    let _ = std::fs::remove_dir_all(&dir);
}
