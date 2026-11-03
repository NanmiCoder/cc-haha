use super::*;
use crate::input::clipboard::test_nonce::test_nonce;
use agent_desktop_core::Deadline;

fn record(nonce: &str) -> OwnerRecord {
    OwnerRecord {
        pid: 4242,
        start_ticks: 9_000_123,
        display: ":7".into(),
        window: 0x40_0001,
        nonce: nonce.into(),
    }
}

fn scratch(label: &str) -> PathBuf {
    use std::os::unix::fs::DirBuilderExt;

    let name = format!("owner-record-{label}");
    let name = agent_desktop_core::temporary_file_name(std::ffi::OsStr::new(&name));
    let dir = std::env::temp_dir().join(name);
    std::fs::DirBuilder::new()
        .mode(0o700)
        .create(&dir)
        .expect("exclusive private temporary directory");
    dir
}

#[test]
fn two_spellings_of_one_display_share_a_name() {
    assert_eq!(normalise_display(":0"), normalise_display(":0.0"));
    assert_ne!(normalise_display(":0"), normalise_display(":0.1"));
    assert_ne!(normalise_display(":0"), normalise_display(":1"));
}

#[test]
fn a_display_name_cannot_escape_the_directory() {
    let name = file_name("../../x:0", &test_nonce()).expect("valid nonce");
    assert!(!name.contains('/'), "{name}");
    assert!(!name.contains(".."), "{name}");
}

#[test]
fn a_nonce_that_is_short_or_has_separators_has_no_file_name() {
    let good = test_nonce();
    let bad = [
        String::new(),
        good[..7].to_owned(),
        format!("{}/", &good[..31]),
        format!("../{}", &good[..28]),
        format!("{good}\n"),
    ];
    for bad in bad {
        assert!(file_name(":0", &bad).is_none(), "{bad:?}");
    }
}

#[test]
fn a_failure_outcome_carries_its_message_and_is_not_a_record() {
    let dir = scratch("failure");
    let nonce = test_nonce();
    publish_failure(&dir, ":7", &nonce, "payload missing").expect("publish");
    assert_eq!(
        read_outcome(&dir, ":7", &nonce),
        Some(Outcome::Failed("payload missing".into()))
    );
    assert!(
        records_in(&dir, ":7", Deadline::standard().unwrap())
            .expect("list")
            .is_empty()
    );
}

#[test]
fn records_are_listed_per_display_only() {
    let dir = scratch("listing");
    let seven_nonce = test_nonce();
    let mut seven = record(&seven_nonce);
    seven.pid = std::process::id();
    seven.start_ticks = start_ticks_of(seven.pid).expect("live process");
    seven.display = ":7".into();
    let mut eight = record(&test_nonce());
    eight.display = ":8".into();
    publish(&dir, &seven).expect("seven");
    publish(&dir, &eight).expect("eight");
    let found = records_in(&dir, ":7.0", Deadline::standard().unwrap()).expect("list");
    assert_eq!(
        found,
        [OwnerRecord {
            pid: seven.pid,
            start_ticks: seven.start_ticks,
            display: normalise_display(&seven.display),
            window: seven.window,
            nonce: seven_nonce,
        }]
    );
}

#[test]
fn stale_and_other_display_records_do_not_block_the_live_owner() {
    let dir = scratch("stale-limit");
    let mut live = record(&test_nonce());
    live.pid = std::process::id();
    live.start_ticks = start_ticks_of(live.pid).expect("live process");
    for index in 0..300 {
        let mut stale = record(&format!("stale{index:08}"));
        stale.pid = if index % 2 == 0 { u32::MAX } else { live.pid };
        stale.start_ticks = live.start_ticks + 1;
        publish(&dir, &stale).expect("stale record");
        let mut foreign = live.clone();
        foreign.display = ":8".into();
        foreign.nonce = format!("foreign{index:08}");
        publish(&dir, &foreign).expect("other display");
    }
    publish(&dir, &live).expect("live owner");
    let found = records_in(&dir, ":7", Deadline::standard().unwrap())
        .expect("stale records must not block discovery");
    assert_eq!(found.len(), 1);
    assert_eq!(found[0].nonce, live.nonce);
    assert_eq!(std::fs::read_dir(&dir).unwrap().count(), 301);
    assert_eq!(
        records_in(&dir, ":8", Deadline::standard().unwrap())
            .unwrap_err()
            .kind(),
        std::io::ErrorKind::InvalidData
    );
}

#[test]
fn an_expired_scan_does_not_read_or_reclaim_records() {
    let dir = scratch("expired-scan");
    publish(&dir, &record(&test_nonce())).unwrap();
    let error = records_in(&dir, ":7", Deadline::after(0).unwrap()).unwrap_err();
    assert_eq!(error.kind(), std::io::ErrorKind::TimedOut);
    assert_eq!(std::fs::read_dir(&dir).unwrap().count(), 1);
}

#[test]
fn an_exiting_owner_removes_its_own_record() {
    let dir = scratch("own");
    let own = record(&test_nonce());
    publish(&dir, &own).expect("publish");
    remove_own(&dir, &own);
    assert!(
        records_in(&dir, ":7", Deadline::standard().unwrap())
            .expect("list")
            .is_empty()
    );
}

#[test]
fn a_file_under_our_name_with_another_nonce_is_not_removed() {
    let dir = scratch("foreign");
    let own = record(&test_nonce());
    let name = file_name(&own.display, &own.nonce).expect("name");
    owner_files::ensure_private_dir(&dir).expect("dir");
    let mut stranger = record(&test_nonce());
    stranger.display = normalise_display(":7");
    owner_files::write_new(&dir, &name, &stranger.to_bytes()).expect("plant");
    remove_own(&dir, &own);
    assert!(dir.join(&name).exists());
}

#[cfg(unix)]
#[test]
fn records_in_rejects_a_symlink_record() {
    use std::os::unix::fs::symlink;

    let dir = scratch("symlink");
    owner_files::ensure_private_dir(&dir).expect("private dir");
    let name = file_name(":7", &test_nonce()).expect("name");
    let target = dir.join("target.json");
    std::fs::write(&target, record(&test_nonce()).to_bytes()).expect("target");
    symlink(&target, dir.join(name)).expect("symlink");
    assert!(
        records_in(&dir, ":7", Deadline::standard().unwrap()).is_err(),
        "symlinks are refused"
    );
}

#[cfg(unix)]
#[test]
fn records_in_rejects_a_fifo_without_waiting_for_a_writer() {
    let dir = scratch("fifo");
    owner_files::ensure_private_dir(&dir).expect("private dir");
    let name =
        std::ffi::CString::new(file_name(":7", &test_nonce()).expect("name")).expect("C string");
    let descriptor = std::fs::File::open(&dir).expect("dir fd");
    rustix::fs::mknodat(
        &descriptor,
        name.as_c_str(),
        rustix::fs::FileType::Fifo,
        rustix::fs::Mode::from_raw_mode(0o600),
        0,
    )
    .expect("fifo");
    assert_eq!(
        records_in(&dir, ":7", Deadline::standard().unwrap())
            .expect_err("FIFOs are refused")
            .kind(),
        std::io::ErrorKind::InvalidData
    );
}

#[cfg(unix)]
#[test]
fn records_in_rejects_an_oversized_record() {
    let dir = scratch("oversized");
    owner_files::ensure_private_dir(&dir).expect("private dir");
    let name = file_name(":7", &test_nonce()).expect("name");
    std::fs::write(
        dir.join(name),
        vec![b'x'; owner_files::MAX_RECORD_BYTES + 1],
    )
    .expect("large record");
    assert_eq!(
        records_in(&dir, ":7", Deadline::standard().unwrap())
            .expect_err("oversized records are refused")
            .kind(),
        std::io::ErrorKind::InvalidData
    );
}

#[cfg(unix)]
#[test]
fn records_in_rejects_a_permissive_directory() {
    use std::os::unix::fs::PermissionsExt;

    let dir = scratch("permissive");
    owner_files::ensure_private_dir(&dir).expect("private dir");
    std::fs::set_permissions(&dir, std::fs::Permissions::from_mode(0o777))
        .expect("permissive mode");
    assert_eq!(
        records_in(&dir, ":7", Deadline::standard().unwrap())
            .expect_err("permissive directory is refused")
            .kind(),
        std::io::ErrorKind::PermissionDenied
    );
}
