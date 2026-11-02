use std::fs;
use std::os::unix::fs::PermissionsExt;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::{Mutex, Once};
use std::thread::sleep;
use std::time::{Duration, Instant};

use agent_desktop_core::{ClipboardContent, ClipboardFormat, Deadline, InputOps, InteractionLease};

use crate::LinuxAdapter;
use crate::input::clipboard::owner::owner_locate::HELPER_NAME;
use crate::input::clipboard::owner::owner_record::{self, OwnerRecord};

static ONE_AT_A_TIME: Mutex<()> = Mutex::new(());

pub(super) struct Session {
    _guard: std::sync::MutexGuard<'static, ()>,
    pub(super) display: String,
}

pub(super) fn private_session() -> Session {
    let guard = ONE_AT_A_TIME
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    let private = std::env::var("AGENT_DESKTOP_PRIVATE_SESSION")
        .expect("run inside scripts/private-session.sh: the live clipboard is never touched");
    let runtime = std::env::var("XDG_RUNTIME_DIR").expect("a private runtime directory");
    assert_eq!(
        runtime, private,
        "the runtime directory must be the private one"
    );
    let display = std::env::var("DISPLAY").expect("the private display");
    assert!(
        std::env::var_os("WAYLAND_DISPLAY").is_none(),
        "a private X11 session carries no Wayland display"
    );
    let home = Path::new(&private).join("clipboard-state");
    fs::create_dir_all(&home).expect("a private state root");
    fs::set_permissions(&home, fs::Permissions::from_mode(0o700)).expect("a private mode");
    unsafe { std::env::set_var("AGENT_DESKTOP_HOME", &home) };
    Session {
        _guard: guard,
        display,
    }
}

pub(super) fn lease() -> InteractionLease {
    InteractionLease::guarded(Deadline::after(20_000).expect("a deadline"), ()).expect("a lease")
}

pub(super) fn deadline() -> Deadline {
    Deadline::after(20_000).expect("a deadline")
}

static BUILT: Once = Once::new();

fn build_helper() {
    let cargo = std::env::var_os("CARGO").unwrap_or_else(|| "cargo".into());
    let mut command = Command::new(cargo);
    command.args(["build", "-p", "agent-desktop-linux", "--bin", HELPER_NAME]);
    if profile_dir().ends_with("release") {
        command.arg("--release");
    }
    let output = command.output().expect("cargo runs");
    assert!(
        output.status.success(),
        "building {HELPER_NAME} failed:\n{}",
        String::from_utf8_lossy(&output.stderr)
    );
}

fn profile_dir() -> PathBuf {
    std::env::current_exe()
        .expect("the test image")
        .parent()
        .and_then(Path::parent)
        .expect("the target directory")
        .to_path_buf()
}

fn build_binaries() {
    BUILT.call_once(|| {
        build_helper();
    });
}

pub(super) fn built_helper() -> PathBuf {
    build_binaries();
    let built = profile_dir().join(HELPER_NAME);
    assert!(built.is_file(), "{HELPER_NAME} is missing after the build");
    built
}

pub(super) fn install_helper_beside_the_image() {
    let beside = std::env::current_exe()
        .expect("the test image")
        .parent()
        .expect("its directory")
        .join(HELPER_NAME);
    let staging = beside.with_extension(format!("new{}", std::process::id()));
    fs::copy(built_helper(), &staging).expect("copy the helper");
    fs::set_permissions(&staging, fs::Permissions::from_mode(0o755)).expect("executable");
    fs::rename(&staging, &beside).expect("install the helper");
}

const READER: &str = r#"
import sys
import gi
gi.require_version("Gtk", "3.0")
gi.require_version("Gdk", "3.0")
from gi.repository import Gdk, Gtk
board = Gtk.Clipboard.get(Gdk.SELECTION_CLIPBOARD)
data = board.wait_for_contents(Gdk.Atom.intern(sys.argv[1], False))
if data is None:
    sys.exit(3)
sys.stdout.buffer.write(bytes(data.get_data()))
"#;

pub(super) const TAKER: &str = r#"
import sys
import gi
gi.require_version("Gtk", "3.0")
gi.require_version("Gdk", "3.0")
from gi.repository import Gdk, Gtk
board = Gtk.Clipboard.get(Gdk.SELECTION_CLIPBOARD)
board.set_text("theirs", -1)
while Gtk.events_pending():
    Gtk.main_iteration()
print("ready", flush=True)
Gtk.main()
"#;

pub(super) fn script(name: &str, source: &str) -> PathBuf {
    let dir = PathBuf::from(std::env::var("XDG_RUNTIME_DIR").expect("the private directory"));
    let path = dir.join(format!("live-{name}.py"));
    fs::write(&path, source).expect("a script");
    path
}

pub(super) fn foreign_read(display: &str, target: &str) -> Option<Vec<u8>> {
    let output = Command::new("python3")
        .arg("-I")
        .arg(script("reader", READER))
        .arg(target)
        .env("DISPLAY", display)
        .stdin(Stdio::null())
        .stderr(Stdio::null())
        .output()
        .expect("python3 runs");
    output.status.success().then_some(output.stdout)
}

pub(super) fn records(display: &str) -> Vec<OwnerRecord> {
    owner_record::record_dir()
        .and_then(|dir| {
            owner_record::records_in(
                &dir,
                display,
                agent_desktop_core::Deadline::standard().unwrap(),
            )
            .ok()
        })
        .unwrap_or_default()
}

pub(super) fn the_record(display: &str) -> OwnerRecord {
    let mut found = records(display);
    assert_eq!(found.len(), 1, "exactly one owner record: {found:?}");
    found.remove(0)
}

pub(super) fn gone(pid: u32) -> bool {
    let path = format!("/proc/{pid}/stat");
    match fs::read_to_string(path) {
        Err(_) => true,
        Ok(stat) => stat
            .rsplit_once(") ")
            .is_some_and(|(_, rest)| rest.starts_with('Z')),
    }
}

pub(super) fn wait_until(what: &str, condition: impl Fn() -> bool) {
    let started = Instant::now();
    while !condition() {
        assert!(
            started.elapsed() < Duration::from_secs(10),
            "timed out: {what}"
        );
        sleep(Duration::from_millis(50));
    }
}

pub(super) fn set(content: &ClipboardContent) {
    LinuxAdapter::new()
        .set_clipboard_content(content, &lease())
        .expect("the clipboard is set");
}

pub(super) fn get(format: ClipboardFormat) -> Option<ClipboardContent> {
    LinuxAdapter::new()
        .get_clipboard_content(format, deadline())
        .expect("the clipboard is read")
}

pub(super) fn clear_and_finish() {
    LinuxAdapter::new()
        .clear_clipboard(&lease())
        .expect("the clipboard is cleared");
}

pub(super) fn text_of(content: Option<ClipboardContent>) -> Option<String> {
    match content {
        Some(ClipboardContent::Text(text)) => Some(text),
        _ => None,
    }
}
