use std::collections::BTreeSet;
use std::sync::{Mutex, MutexGuard};
use std::time::{Duration, Instant};

use x11rb::connection::Connection;
use x11rb::protocol::xproto::{AtomEnum, ConnectionExt};
use x11rb::rust_connection::RustConnection;

static ONE_AT_A_TIME: Mutex<()> = Mutex::new(());

const GONE_WITHIN: Duration = Duration::from_secs(5);

fn connect() -> (RustConnection, u32) {
    let display = std::env::var("DISPLAY").expect("a private display");
    let private = std::env::var("AGENT_DESKTOP_PRIVATE_SESSION").expect("a private session");
    let started = std::fs::read_to_string(format!("{private}/displayfd")).expect("its display");
    assert_eq!(
        display,
        format!(":{}", started.trim()),
        "the display is not the one the private session started"
    );
    let (connection, screen) = RustConnection::connect(Some(&display)).expect("connect");
    let root = connection.setup().roots[screen].root;
    (connection, root)
}

fn children_of(connection: &RustConnection, window: u32) -> Vec<u32> {
    connection
        .query_tree(window)
        .ok()
        .and_then(|cookie| cookie.reply().ok())
        .map(|tree| tree.children)
        .unwrap_or_default()
}

fn root_children() -> BTreeSet<u32> {
    let (connection, root) = connect();
    children_of(&connection, root).into_iter().collect()
}

fn owner_pid(connection: &RustConnection, window: u32) -> Option<u32> {
    let atom = connection
        .intern_atom(false, b"_NET_WM_PID")
        .ok()?
        .reply()
        .ok()?
        .atom;
    let reply = connection
        .get_property(false, window, atom, AtomEnum::CARDINAL, 0, 1)
        .ok()?
        .reply()
        .ok()?;
    reply.value32()?.next()
}

fn process_is_gone(pid: u32) -> bool {
    match std::fs::read_to_string(format!("/proc/{pid}/stat")) {
        Err(_) => true,
        Ok(stat) => stat
            .rsplit_once(") ")
            .is_some_and(|(_, rest)| rest.starts_with('Z')),
    }
}

fn orphaned_windows(baseline: &BTreeSet<u32>) -> Vec<u32> {
    let (connection, root) = connect();
    let mut found = Vec::new();
    for top in children_of(&connection, root) {
        if baseline.contains(&top) {
            continue;
        }
        let mut family = vec![top];
        family.extend(children_of(&connection, top));
        for window in family {
            if owner_pid(&connection, window).is_some_and(process_is_gone) {
                found.push(window);
            }
        }
    }
    found
}

/// Held by a live test for its whole run. The tests of one process share one
/// private display, and a test that paints or grabs the whole screen sees the
/// windows of every test running beside it, so the next test starts only
/// after the windows of this test's stopped processes have left the display.
pub(crate) struct Exclusive {
    _guard: MutexGuard<'static, ()>,
    baseline: BTreeSet<u32>,
}

pub(crate) fn exclusive() -> Exclusive {
    let guard = ONE_AT_A_TIME
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    Exclusive {
        _guard: guard,
        baseline: root_children(),
    }
}

impl Drop for Exclusive {
    fn drop(&mut self) {
        let started = Instant::now();
        loop {
            let left = orphaned_windows(&self.baseline);
            if left.is_empty() {
                return;
            }
            if started.elapsed() >= GONE_WITHIN {
                assert!(
                    std::thread::panicking(),
                    "windows of stopped processes are still on the display: {left:?}"
                );
                return;
            }
            std::thread::sleep(Duration::from_millis(20));
        }
    }
}

pub(crate) struct Private {
    _exclusive: Exclusive,
    name: String,
}

impl std::ops::Deref for Private {
    type Target = String;

    fn deref(&self) -> &String {
        &self.name
    }
}

pub(crate) fn private_display() -> Private {
    let exclusive = exclusive();
    let display = std::env::var("DISPLAY").expect("DISPLAY");
    let private = std::env::var("AGENT_DESKTOP_PRIVATE_SESSION").expect("a private session");
    assert!(!private.is_empty() && !matches!(display.as_str(), ":0" | ":99" | ""));
    Private {
        _exclusive: exclusive,
        name: display,
    }
}
