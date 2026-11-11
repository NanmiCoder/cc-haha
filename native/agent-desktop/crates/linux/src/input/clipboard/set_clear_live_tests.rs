use agent_desktop_core::{ClipboardContent, ClipboardFormat};
use std::fs;
use std::path::Path;
use std::process::{Command, Stdio};

use crate::input::clipboard::owner::owner_record;

#[path = "set_clear_live_support.rs"]
mod support;
use support::*;

#[path = "owner_live_tests.rs"]
mod owner_tests;

#[test]
#[ignore = "needs a private X11 session and the built clipboard owner"]
fn text_set_is_served_by_a_detached_owner_and_read_by_a_second_process() {
    let session = private_session();
    install_helper_beside_the_image();
    set(&ClipboardContent::Text("live text value".into()));
    let owner = the_record(&session.display);
    assert_eq!(
        owner_record::start_ticks_of(owner.pid),
        Some(owner.start_ticks)
    );
    for target in [
        "UTF8_STRING",
        "text/plain;charset=utf-8",
        "text/plain",
        "STRING",
    ] {
        assert_eq!(
            foreign_read(&session.display, target).as_deref(),
            Some(b"live text value".as_slice()),
            "{target}"
        );
    }
    for descriptor in 0..3 {
        let link = fs::read_link(format!("/proc/{}/fd/{descriptor}", owner.pid)).expect("a link");
        assert_eq!(link, Path::new("/dev/null"), "descriptor {descriptor}");
    }
    let stat = fs::read_to_string(format!("/proc/{}/stat", owner.pid)).expect("stat");
    let session_id = stat
        .rsplit_once(") ")
        .and_then(|(_, rest)| rest.split_whitespace().nth(3))
        .and_then(|field| field.parse::<u32>().ok());
    assert_eq!(
        session_id,
        Some(owner.pid),
        "the owner leads its own session"
    );
    let environment = fs::read(format!("/proc/{}/environ", owner.pid)).expect("environ");
    let names: Vec<String> = environment
        .split(|byte| *byte == 0)
        .filter_map(|entry| String::from_utf8(entry.to_vec()).ok())
        .filter_map(|entry| entry.split_once('=').map(|(name, _)| name.to_owned()))
        .collect();
    assert!(!names.iter().any(|name| name == "PATH"), "{names:?}");
    assert!(
        !names.iter().any(|name| name.contains("LEASE")),
        "{names:?}"
    );
    assert_eq!(
        text_of(get(ClipboardFormat::Text)),
        Some("live text value".into())
    );
    clear_and_finish();
}

#[test]
#[ignore = "needs a private X11 session and the built clipboard owner"]
fn a_second_set_replaces_the_first_owner_and_leaves_one_record() {
    let session = private_session();
    install_helper_beside_the_image();
    set(&ClipboardContent::Text("first".into()));
    let first = the_record(&session.display);
    set(&ClipboardContent::Text("second".into()));
    wait_until("the first owner ends", || gone(first.pid));
    let second = the_record(&session.display);
    assert_ne!(first.pid, second.pid);
    assert_eq!(
        foreign_read(&session.display, "UTF8_STRING").as_deref(),
        Some(b"second".as_slice())
    );
    clear_and_finish();
}

#[test]
#[ignore = "needs a private X11 session and the built clipboard owner"]
fn a_text_above_the_incr_threshold_round_trips_through_both_readers() {
    let session = private_session();
    install_helper_beside_the_image();
    let big: String = (0..3 * 1024 * 1024u32)
        .map(|n| char::from(b'a' + (n % 26) as u8))
        .collect();
    set(&ClipboardContent::Text(big.clone()));
    let foreign = foreign_read(&session.display, "UTF8_STRING").expect("a foreign read");
    assert!(
        foreign == big.as_bytes(),
        "the foreign reader must get every byte"
    );
    let ours = text_of(get(ClipboardFormat::Text)).expect("our read");
    assert!(ours == big, "our INCR reader must get every byte");
    clear_and_finish();
}

#[test]
#[ignore = "needs a private X11 session and the built clipboard owner"]
fn file_paths_are_served_under_both_file_manager_targets() {
    let session = private_session();
    install_helper_beside_the_image();
    set(&ClipboardContent::FileUrls(vec![
        "/tmp/a b".into(),
        "/tmp/c".into(),
    ]));
    assert_eq!(
        foreign_read(&session.display, "text/uri-list").as_deref(),
        Some(b"file:///tmp/a%20b\r\nfile:///tmp/c\r\n".as_slice())
    );
    assert_eq!(
        foreign_read(&session.display, "x-special/gnome-copied-files").as_deref(),
        Some(b"copy\nfile:///tmp/a%20b\nfile:///tmp/c".as_slice())
    );
    let Some(ClipboardContent::FileUrls(paths)) = get(ClipboardFormat::Auto) else {
        panic!("Auto prefers file paths")
    };
    assert_eq!(paths, ["/tmp/a b", "/tmp/c"]);
    clear_and_finish();
}

#[test]
#[ignore = "needs a private X11 session and the built clipboard owner"]
fn the_owner_exits_when_another_client_takes_the_selection() {
    let session = private_session();
    install_helper_beside_the_image();
    set(&ClipboardContent::Text("ours".into()));
    let owner = the_record(&session.display);
    let mut taker = Command::new("setsid")
        .args(["python3", "-I"])
        .arg(script("taker", TAKER))
        .env("DISPLAY", &session.display)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()
        .expect("a second client takes the selection");
    let mut ready = String::new();
    std::io::BufRead::read_line(
        &mut std::io::BufReader::new(taker.stdout.take().expect("a pipe")),
        &mut ready,
    )
    .expect("the taker reports");
    assert_eq!(ready.trim(), "ready");
    wait_until("our owner ends", || gone(owner.pid));
    wait_until("our record is removed", || {
        records(&session.display).is_empty()
    });
    assert_eq!(
        foreign_read(&session.display, "UTF8_STRING").as_deref(),
        Some(b"theirs".as_slice())
    );
    let _ = taker.kill();
    let _ = taker.wait();
}
