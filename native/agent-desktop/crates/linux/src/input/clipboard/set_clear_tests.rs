use std::cell::{Cell, RefCell};
use std::collections::VecDeque;
use std::fs;
use std::os::unix::fs::PermissionsExt;
use std::path::{Path, PathBuf};
use std::process::{Child, Command};

use agent_desktop_core::{ClipboardContent, Deadline, DeliverySemantics, ErrorCode};
use rustix::process::{Pid, Signal, kill_process};

use super::*;
use crate::input::clipboard::owner::owner_files;
use crate::input::clipboard::owner::owner_record::start_ticks_of;
use crate::input::clipboard::test_nonce::test_nonce;
use crate::input::clipboard::x11_read::Fault;

const DISPLAY: &str = ":77";
const WINDOW: u32 = 4242;

struct FakeServer {
    owners: RefCell<VecDeque<Option<u32>>>,
    targets: Vec<String>,
    released: Cell<u32>,
    release_fault: RefCell<Option<Fault>>,
}

impl FakeServer {
    fn new(owners: &[Option<u32>], targets: &[&str]) -> Self {
        Self {
            owners: RefCell::new(owners.iter().copied().collect()),
            targets: targets.iter().map(|name| (*name).to_owned()).collect(),
            released: Cell::new(0),
            release_fault: RefCell::new(None),
        }
    }
}

impl SelectionServer for FakeServer {
    fn owner(&self, _display: &str, _deadline: Deadline) -> Result<Option<u32>, Fault> {
        let mut owners = self.owners.borrow_mut();
        if owners.len() > 1 {
            Ok(owners.pop_front().flatten())
        } else {
            Ok(owners.front().copied().flatten())
        }
    }

    fn targets(&self, _display: &str, _deadline: Deadline) -> Result<Vec<String>, Fault> {
        Ok(self.targets.clone())
    }

    fn release(&self, _display: &str, _deadline: Deadline) -> Result<(), Fault> {
        self.released.set(self.released.get() + 1);
        match self.release_fault.borrow().clone() {
            Some(fault) => Err(fault),
            None => Ok(()),
        }
    }
}

struct World {
    root: PathBuf,
    records: PathBuf,
    nonce: String,
}

impl World {
    fn new(name: &str) -> Self {
        let root = std::env::temp_dir().join(format!("ad-setclear-{name}-{}", std::process::id()));
        let _ = fs::remove_dir_all(&root);
        let records = root.join("clipboard");
        fs::create_dir_all(&records).expect("a record directory");
        fs::set_permissions(&records, fs::Permissions::from_mode(0o700)).expect("private");
        Self {
            root,
            records,
            nonce: test_nonce(),
        }
    }

    fn helper(&self, script: &str) -> PathBuf {
        let helper = self.root.join("helper");
        crate::input::clipboard::test_script::write_executable(
            &helper,
            &format!("#!/bin/sh\n{script}\n"),
        );
        helper
    }

    fn env_var(&self, name: &str) -> Option<String> {
        (name == "AGENT_DESKTOP_HOME").then(|| self.root.display().to_string())
    }

    fn pid_file(&self) -> PathBuf {
        self.root.join("pid")
    }

    fn pid(&self) -> Option<u32> {
        fs::read_to_string(self.pid_file())
            .ok()?
            .trim()
            .parse()
            .ok()
    }

    fn record_names(&self) -> Vec<String> {
        let mut names: Vec<String> = fs::read_dir(&self.records)
            .expect("the record directory")
            .filter_map(Result::ok)
            .map(|entry| entry.file_name().to_string_lossy().into_owned())
            .collect();
        names.sort();
        names
    }
}

const HANGS: &str = "echo $$ > \"$AGENT_DESKTOP_HOME/pid\"\nexec sleep 30";
const EXITS: &str = "exit 3";
const CLAIMS: &str = "echo $$ > \"$AGENT_DESKTOP_HOME/pid\"\n\
d=\"$AGENT_DESKTOP_HOME/clipboard\"\n\
n=\"$AGENT_DESKTOP_SELECTION_NONCE\"\n\
printf '{\"pid\":%s,\"start_ticks\":1,\"display\":\"_77\",\"window\":4242,\"nonce\":\"%s\"}' $$ \"$n\" > \"$d/owner-_77-$n.json\"\n\
exec sleep 30";

fn lease(ms: u64) -> InteractionLease {
    InteractionLease::guarded(Deadline::after(ms).expect("a deadline"), ()).expect("a lease")
}

fn text(value: &str) -> ClipboardContent {
    ClipboardContent::Text(value.to_owned())
}

fn text_targets() -> [&'static str; 4] {
    [
        "UTF8_STRING",
        "text/plain;charset=utf-8",
        "text/plain",
        "STRING",
    ]
}

fn run_set(
    world: &World,
    helper: &Path,
    server: &FakeServer,
    content: &ClipboardContent,
    ms: u64,
) -> Result<(), AdapterError> {
    let parent = |name: &str| world.env_var(name);
    set_with(
        &Env {
            helper,
            record_dir: &world.records,
            server,
            parent_env: &parent,
            nonce: &world.nonce,
        },
        DISPLAY,
        content,
        &lease(ms),
    )
}

fn run_clear(world: &World, server: &FakeServer) -> Result<(), AdapterError> {
    let parent = |name: &str| world.env_var(name);
    let nonce = test_nonce();
    clear_with(
        &Env {
            helper: Path::new(""),
            record_dir: &world.records,
            server,
            parent_env: &parent,
            nonce: &nonce,
        },
        DISPLAY,
        &lease(2_000),
    )
}

fn terminate(pid: Option<u32>) {
    let pid = pid
        .and_then(|pid| i32::try_from(pid).ok())
        .and_then(Pid::from_raw);
    if let Some(pid) = pid {
        let _ = kill_process(pid, Signal::KILL);
    }
}

fn alive(pid: u32) -> bool {
    start_ticks_of(pid).is_some()
        && !fs::read_to_string(format!("/proc/{pid}/stat"))
            .map(|stat| stat.contains(") Z"))
            .unwrap_or(true)
}

fn sleeper() -> Child {
    Command::new("sleep")
        .arg("30")
        .spawn()
        .expect("a sleeping child")
}

fn write_record(world: &World, pid: u32, start_ticks: u64, nonce: &str) {
    let record = OwnerRecord {
        pid,
        start_ticks,
        display: DISPLAY.to_owned(),
        window: 1,
        nonce: nonce.to_owned(),
    };
    let name = owner_record::file_name(DISPLAY, nonce).expect("a name");
    owner_files::write_new(&world.records, &name, &record.to_bytes()).expect("a record");
}

#[test]
fn a_helper_that_exits_before_claiming_is_not_delivered() {
    let world = World::new("exits");
    let helper = world.helper(EXITS);
    let server = FakeServer::new(&[Some(7)], &[]);
    let error = run_set(&world, &helper, &server, &text("hello"), 3_000).expect_err("refused");
    assert_eq!(error.code, ErrorCode::ActionFailed);
    assert_eq!(error.disposition, DeliverySemantics::not_delivered());
}

#[test]
fn a_helper_that_cannot_start_is_not_delivered() {
    let world = World::new("nostart");
    let server = FakeServer::new(&[None], &[]);
    let error = run_set(
        &world,
        &world.root.join("absent"),
        &server,
        &text("hello"),
        1_000,
    )
    .expect_err("refused");
    assert_eq!(error.code, ErrorCode::ActionFailed);
    assert_eq!(error.disposition, DeliverySemantics::not_delivered());
}

#[test]
fn no_handshake_kills_the_child_and_is_a_timeout_with_an_uncertain_disposition() {
    let world = World::new("hangs");
    let helper = world.helper(HANGS);
    let server = FakeServer::new(&[None], &[]);
    let error = run_set(&world, &helper, &server, &text("hello"), 400).expect_err("a timeout");
    assert_eq!(error.code, ErrorCode::Timeout);
    assert_eq!(error.disposition, DeliverySemantics::uncertain());
    let pid = world.pid().expect("the child wrote its pid");
    assert!(!alive(pid), "the child must be killed");
    terminate(Some(pid));
}

#[test]
fn a_timeout_is_not_delivered_when_the_earlier_owner_still_holds_the_selection() {
    let world = World::new("hangs-prior");
    let helper = world.helper(HANGS);
    let server = FakeServer::new(&[Some(100)], &[]);
    let error = run_set(&world, &helper, &server, &text("hello"), 400).expect_err("a timeout");
    assert_eq!(error.code, ErrorCode::Timeout);
    assert_eq!(error.disposition, DeliverySemantics::not_delivered());
    terminate(world.pid());
}

#[test]
fn a_timeout_is_uncertain_when_the_selection_changed_hands() {
    let world = World::new("hangs-changed");
    let helper = world.helper(HANGS);
    let server = FakeServer::new(&[Some(100), Some(200)], &[]);
    let error = run_set(&world, &helper, &server, &text("hello"), 400).expect_err("a timeout");
    assert_eq!(error.disposition, DeliverySemantics::uncertain());
    terminate(world.pid());
}

#[test]
fn a_failed_verification_after_the_claim_is_unresponsive_and_delivered_unverified() {
    let world = World::new("unverified");
    let helper = world.helper(CLAIMS);
    let server = FakeServer::new(&[None, Some(WINDOW + 1)], &text_targets());
    let error = run_set(&world, &helper, &server, &text("hello"), 5_000).expect_err("unverified");
    assert_eq!(error.code, ErrorCode::AppUnresponsive);
    assert_eq!(error.disposition, DeliverySemantics::delivered_unverified());
    terminate(world.pid());
}

#[test]
fn an_owner_missing_a_served_target_is_not_verified() {
    let world = World::new("missing-target");
    let helper = world.helper(CLAIMS);
    let server = FakeServer::new(&[None, Some(WINDOW)], &["UTF8_STRING"]);
    let error = run_set(&world, &helper, &server, &text("hello"), 5_000).expect_err("unverified");
    assert_eq!(error.code, ErrorCode::AppUnresponsive);
    terminate(world.pid());
}

#[test]
fn a_second_set_stops_the_earlier_owner_after_the_new_claim_and_leaves_one_record() {
    let world = World::new("replace");
    let mut earlier = sleeper();
    let ticks = start_ticks_of(earlier.id()).expect("start time");
    write_record(&world, earlier.id(), ticks, &test_nonce());
    let helper = world.helper(CLAIMS);
    let server = FakeServer::new(&[None, Some(WINDOW)], &text_targets());
    run_set(&world, &helper, &server, &text("hello"), 5_000).expect("set");
    let status = earlier.wait().expect("the earlier owner ends");
    assert!(!status.success());
    let names = world.record_names();
    assert_eq!(names.len(), 1, "{names:?}");
    assert!(names[0].contains(&world.nonce), "{names:?}");
    terminate(world.pid());
}

#[test]
fn an_over_cap_payload_is_invalid_args_before_any_process_or_file() {
    let world = World::new("overcap");
    let helper = world.helper(CLAIMS);
    let server = FakeServer::new(&[None], &[]);
    let huge = text(&"x".repeat(agent_desktop_core::MAX_PNG_INPUT_BYTES + 1));
    let error = run_set(&world, &helper, &server, &huge, 2_000).expect_err("over the cap");
    assert_eq!(error.code, ErrorCode::InvalidArgs);
    assert_eq!(error.disposition, DeliverySemantics::not_delivered());
    assert!(world.pid().is_none(), "no helper may start");
    assert!(world.record_names().is_empty());
}

#[test]
fn no_payload_descriptor_stays_open_after_a_failed_set() {
    let mut world = World::new("fd-closed");
    world.nonce = test_nonce();
    let helper = world.helper(EXITS);
    let server = FakeServer::new(&[None], &[]);
    let _ = run_set(&world, &helper, &server, &text("hello"), 3_000);
    let leaked = fs::read_dir("/proc/self/fd")
        .expect("the descriptors")
        .filter_map(Result::ok)
        .filter_map(|entry| fs::read_link(entry.path()).ok())
        .any(|link| {
            link.to_string_lossy()
                .contains(&format!("memfd:ad-payload-{}", world.nonce))
        });
    assert!(!leaked);
}

#[path = "set_clear_clear_tests.rs"]
mod clear_tests;

#[test]
fn record_scan_timeout_preserves_set_and_clear_delivery_states() {
    for clear in [false, true] {
        let world = World::new(if clear { "scan-clear" } else { "scan-set" });
        write_record(&world, u32::MAX, 1, &test_nonce());
        let server = FakeServer::new(&[None], &[]);
        let parent = |name: &str| world.env_var(name);
        let env = Env {
            helper: Path::new("/nonexistent/helper"),
            record_dir: &world.records,
            server: &server,
            parent_env: &parent,
            nonce: &world.nonce,
        };
        let lease = lease(100);
        std::thread::sleep(std::time::Duration::from_millis(120));
        let result = if clear {
            clear_with(&env, DISPLAY, &lease)
        } else {
            set_with(&env, DISPLAY, &text("unchanged"), &lease)
        };
        let error = result.expect_err("expired record scan");
        assert_eq!(error.code, ErrorCode::Timeout);
        assert_eq!(server.released.get(), u32::from(clear));
        assert_eq!(
            error.disposition,
            if clear {
                DeliverySemantics::delivered_unverified()
            } else {
                DeliverySemantics::not_delivered()
            }
        );
    }
}

#[path = "set_clear_reaper_tests.rs"]
mod reaper_tests;
