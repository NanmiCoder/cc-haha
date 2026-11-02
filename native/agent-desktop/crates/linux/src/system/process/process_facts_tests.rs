use super::{Lookup, lookup_for_error, process_instance, read};

#[test]
fn different_start_times_give_different_tokens() {
    assert_ne!(
        process_instance("0123456789abcdef", 10),
        process_instance("0123456789abcdef", 11)
    );
}

#[test]
fn a_different_boot_gives_a_different_token_for_the_same_start_time() {
    assert_ne!(
        process_instance("aaaaaaaa-1111", 10),
        process_instance("bbbbbbbb-1111", 10)
    );
}

#[test]
fn a_process_that_does_not_exist_has_no_facts() {
    assert_eq!(read(u32::MAX), None);
}

#[cfg(target_os = "linux")]
#[test]
fn the_current_process_reads_a_stable_token() {
    let first = read(std::process::id()).expect("the test process is running");
    let second = read(std::process::id()).expect("the test process is running");
    assert_eq!(first.instance, second.instance);
    assert!(!first.comm.is_empty());
}

#[test]
fn only_a_read_that_failed_because_the_process_left_says_gone() {
    use std::io::{Error, ErrorKind};
    assert_eq!(
        lookup_for_error(&Error::from(ErrorKind::NotFound)),
        Lookup::Gone
    );
    assert_eq!(lookup_for_error(&Error::from_raw_os_error(3)), Lookup::Gone);
    assert_eq!(
        lookup_for_error(&Error::from(ErrorKind::PermissionDenied)),
        Lookup::Unreadable
    );
    assert_eq!(
        lookup_for_error(&Error::from_raw_os_error(24)),
        Lookup::Unreadable
    );
}
