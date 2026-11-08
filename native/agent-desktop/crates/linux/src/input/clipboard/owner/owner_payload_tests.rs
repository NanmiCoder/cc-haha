use std::io::{Seek, Write};
use std::os::fd::IntoRawFd;
use std::os::unix::fs::MetadataExt;

use super::*;
use crate::input::clipboard::payload::frame;
use crate::input::clipboard::target::Target;

fn framed() -> Vec<u8> {
    frame(&Payload {
        targets: vec![Target {
            name: "UTF8_STRING".into(),
            bytes: b"hello".to_vec(),
        }],
    })
}

fn descriptor_holding(bytes: &[u8]) -> i32 {
    let mut file = tempfile_in_memory();
    file.write_all(bytes).expect("write");
    file.rewind().expect("rewind");
    file.into_raw_fd()
}

fn tempfile_in_memory() -> File {
    let path = std::env::temp_dir().join(format!(
        "owner-payload-{}-{:?}",
        std::process::id(),
        std::thread::current().id()
    ));
    let file = std::fs::OpenOptions::new()
        .read(true)
        .write(true)
        .create(true)
        .truncate(true)
        .open(&path)
        .expect("scratch file");
    std::fs::remove_file(&path).expect("unlink");
    file
}

#[test]
fn an_inherited_descriptor_is_read_and_closed() {
    let number = descriptor_holding(&framed());
    let path = format!("/proc/self/fd/{number}");
    let inode = std::fs::metadata(&path)
        .expect("open before the read")
        .ino();
    let payload = read_payload(Some(&number.to_string())).expect("payload");
    assert_eq!(payload.targets[0].bytes, b"hello");
    let still_ours = std::fs::metadata(&path).is_ok_and(|after| after.ino() == inode);
    assert!(!still_ours, "the descriptor is closed after the read");
}

#[test]
fn no_descriptor_is_a_named_failure() {
    assert!(read_payload(None).is_err());
}

#[test]
fn a_descriptor_that_is_not_a_number_is_refused() {
    assert!(read_payload(Some("seven")).is_err());
}

#[test]
fn a_number_that_is_not_open_is_refused() {
    let error = read_payload(Some("987654")).expect_err("not open");
    assert!(error.contains("not open"), "{error}");
}

#[test]
fn a_standard_stream_is_never_adopted() {
    for number in ["0", "1", "2", "-1"] {
        let error = read_payload(Some(number)).expect_err("refused");
        assert!(
            error.contains("is not an inherited one"),
            "{number}: {error}"
        );
    }
}

#[test]
fn a_truncated_payload_is_refused() {
    let mut bytes = framed();
    bytes.truncate(bytes.len() - 2);
    let number = descriptor_holding(&bytes);
    assert!(read_payload(Some(&number.to_string())).is_err());
}
