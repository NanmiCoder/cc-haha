use std::collections::BTreeSet;
use std::os::unix::process::CommandExt;
use std::path::PathBuf;
use std::process::{Child, Command, Stdio};
use std::sync::mpsc;
use std::time::{Duration, Instant};

use agent_desktop_core::{ImageBuffer, ImageFormat};
use zbus::blocking::Connection;
use zbus::zvariant::OwnedObjectPath;

use super::*;

const ATTEMPTS: u32 = 8;
const SOCKET_WAIT: Duration = Duration::from_secs(20);
const SEAT_WAIT: Duration = Duration::from_secs(8);
const SERVICE: &str = "org.gnome.Mutter.RemoteDesktop";
const PATH: &str = "/org/gnome/Mutter/RemoteDesktop";
const SESSION: &str = "org.gnome.Mutter.RemoteDesktop.Session";
const BUTTON_LEFT: i32 = 272;
const SHIFT_L: u32 = 0xffe1;

const GTK_READER: &str = r#"
import gi
gi.require_version("Gtk", "4.0")
from gi.repository import Gtk, Gdk, GLib
Gtk.init()
loop = GLib.MainLoop()
window = Gtk.Window(title="ad-wl-reader")
window.present()
def ask():
    Gdk.Display.get_default().get_clipboard().read_text_async(None, done)
    return False
def done(clipboard, result):
    try:
        print("text=" + str(clipboard.read_text_finish(result)))
    except Exception as error:
        print("error=" + str(error))
    loop.quit()
GLib.timeout_add(1500, ask)
GLib.timeout_add(9000, loop.quit)
loop.run()
"#;

fn runtime_dir() -> PathBuf {
    PathBuf::from(std::env::var("XDG_RUNTIME_DIR").expect("a private runtime dir"))
}

fn sockets() -> BTreeSet<String> {
    std::fs::read_dir(runtime_dir())
        .map(|entries| {
            entries
                .flatten()
                .filter_map(|entry| entry.file_name().into_string().ok())
                .filter(|name| name.starts_with("wayland-") && !name.ends_with(".lock"))
                .collect()
        })
        .unwrap_or_default()
}

struct Shell {
    child: Child,
    socket: String,
}

impl Drop for Shell {
    fn drop(&mut self) {
        let group = format!("-{}", self.child.id());
        let _ = Command::new("kill").args(["-KILL", "--", &group]).status();
        let _ = self.child.kill();
        let _ = self.child.wait();
        std::thread::sleep(Duration::from_secs(2));
    }
}

fn spawn_shell() -> Option<Shell> {
    for name in sockets() {
        let _ = std::fs::remove_file(runtime_dir().join(&name));
        let _ = std::fs::remove_file(runtime_dir().join(format!("{name}.lock")));
    }
    let before = sockets();
    let log = std::fs::File::create(runtime_dir().join("shell.log")).ok()?;
    let child = Command::new("gnome-shell")
        .args(["--headless", "--wayland", "--virtual-monitor", "1280x800"])
        .env_remove("DISPLAY")
        .env_remove("WAYLAND_DISPLAY")
        .stdin(Stdio::null())
        .stdout(log.try_clone().ok()?)
        .stderr(log)
        .process_group(0)
        .spawn()
        .ok()?;
    let mut shell = Shell {
        child,
        socket: String::new(),
    };
    let until = Instant::now() + SOCKET_WAIT;
    while Instant::now() < until && shell.socket.is_empty() {
        if let Some(new) = sockets().difference(&before).next() {
            shell.socket = new.clone();
        }
        std::thread::sleep(Duration::from_millis(200));
    }
    if shell.socket.is_empty() {
        return None;
    }
    std::thread::sleep(Duration::from_secs(3));
    Some(shell)
}

struct Seat {
    _connection: Connection,
}

fn open_seat() -> Result<Seat, String> {
    let connection = Connection::session().map_err(|error| error.to_string())?;
    let reply = connection
        .call_method(Some(SERVICE), PATH, Some(SERVICE), "CreateSession", &())
        .map_err(|error| error.to_string())?;
    let session = reply
        .body()
        .deserialize::<OwnedObjectPath>()
        .map_err(|error| error.to_string())?;
    macro_rules! call {
        ($member:expr, $body:expr) => {
            connection
                .call_method(
                    Some(SERVICE),
                    session.as_str(),
                    Some(SESSION),
                    $member,
                    $body,
                )
                .map(|_| ())
                .map_err(|error| error.to_string())
        };
    }
    call!("Start", &())?;
    for down in [true, false] {
        call!("NotifyKeyboardKeysym", &(SHIFT_L, down))?;
    }
    call!("NotifyPointerMotionRelative", &(300.0_f64, 300.0_f64))?;
    std::thread::sleep(Duration::from_millis(300));
    for down in [true, false] {
        call!("NotifyPointerButton", &(BUTTON_LEFT, down))?;
        std::thread::sleep(Duration::from_millis(100));
    }
    std::thread::sleep(Duration::from_secs(1));
    Ok(Seat {
        _connection: connection,
    })
}

fn bounded_seat() -> Option<Seat> {
    let (sender, receiver) = mpsc::channel();
    std::thread::spawn(move || {
        let _ = sender.send(open_seat());
    });
    receiver.recv_timeout(SEAT_WAIT).ok()?.ok()
}

struct World {
    _shell: Shell,
    _seat: Seat,
    runner: ProcessRunner,
    search_path: Option<OsString>,
}

impl World {
    fn wayland(&self) -> Wayland<'_> {
        Wayland {
            runner: &self.runner,
            search_path: self.search_path.clone(),
        }
    }

    fn foreign(&self, program: &str, args: &[&str], stdin: Option<&[u8]>) -> RunOutcome {
        let spec = RunSpec {
            program: locate(program, self.search_path.as_deref()).expect("a wl-clipboard tool"),
            args: args.iter().map(|arg| (*arg).to_owned()).collect(),
            stdin: stdin.map(<[u8]>::to_vec),
            capture_stdout: true,
        };
        self.runner
            .run(&spec, Deadline::after(8_000).expect("a deadline"))
    }
}

fn boot() -> World {
    assert!(
        std::env::var_os("AGENT_DESKTOP_PRIVATE_SESSION").is_some(),
        "run inside scripts/private-session.sh"
    );
    assert!(
        std::env::var_os("WAYLAND_DISPLAY").is_none(),
        "the live Wayland display must not be inherited"
    );
    let search_path = std::env::var_os("PATH");
    for _ in 0..ATTEMPTS {
        let Some(shell) = spawn_shell() else { continue };
        let Some(seat) = bounded_seat() else { continue };
        let world = World {
            runner: ProcessRunner {
                env: vec![("WAYLAND_DISPLAY".into(), shell.socket.clone())],
            },
            _shell: shell,
            _seat: seat,
            search_path: search_path.clone(),
        };
        let answered = world.foreign(PASTE, &["--list-types"], None);
        if matches!(answered, RunOutcome::Exited { .. }) {
            return world;
        }
    }
    panic!("no healthy headless gnome-shell after {ATTEMPTS} starts");
}

fn stdout_of(outcome: RunOutcome) -> String {
    match outcome {
        RunOutcome::Exited { stdout, .. } => String::from_utf8_lossy(&stdout).into_owned(),
        other => panic!("the foreign tool did not finish: {other:?}"),
    }
}

fn png() -> Vec<u8> {
    let mut data = vec![0x89, b'P', b'N', b'G', 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13];
    data.extend_from_slice(b"IHDR");
    data.extend_from_slice(&2u32.to_be_bytes());
    data.extend_from_slice(&3u32.to_be_bytes());
    data.extend_from_slice(&[8, 2, 0, 0, 0, 0, 0, 0, 0]);
    data
}

fn text_of(content: Option<ClipboardContent>) -> Option<String> {
    match content {
        Some(ClipboardContent::Text(text)) => Some(text),
        _ => None,
    }
}

fn gtk_text(world: &World) -> String {
    let spec = RunSpec {
        program: PathBuf::from("/usr/bin/python3"),
        args: vec!["-c".into(), GTK_READER.into()],
        stdin: None,
        capture_stdout: true,
    };
    let runner = ProcessRunner {
        env: vec![
            ("WAYLAND_DISPLAY".into(), world._shell.socket.clone()),
            ("GDK_BACKEND".into(), "wayland".into()),
        ],
    };
    stdout_of(runner.run(&spec, Deadline::after(15_000).expect("a deadline")))
}

#[test]
#[ignore = "boots a private headless gnome-shell; run inside scripts/private-session.sh"]
fn text_round_trips_with_foreign_readers_and_writers() {
    let world = boot();
    let wayland = world.wayland();
    let lease = || {
        InteractionLease::guarded(Deadline::after(8_000).expect("a deadline"), ()).expect("a lease")
    };

    wayland.clear(&lease()).expect("a clear");
    assert!(
        wayland
            .read(ClipboardFormat::Auto, Deadline::after(8_000).unwrap())
            .expect("a read")
            .is_none()
    );

    wayland
        .set(&ClipboardContent::Text("set-by-adapter é".into()), &lease())
        .expect("a set");
    assert_eq!(
        stdout_of(world.foreign(PASTE, &["--no-newline"], None)),
        "set-by-adapter é"
    );
    assert!(gtk_text(&world).contains("text=set-by-adapter é"));
    std::thread::sleep(Duration::from_secs(2));
    let later = wayland
        .read(ClipboardFormat::Text, Deadline::after(8_000).unwrap())
        .expect("a read");
    assert_eq!(
        text_of(later).as_deref(),
        Some("set-by-adapter é"),
        "the content must outlive the setter's process"
    );

    world.foreign(COPY, &["--type", "text/plain"], Some(b"set-by-foreign"));
    let foreign = wayland
        .read(ClipboardFormat::Auto, Deadline::after(8_000).unwrap())
        .expect("a read");
    assert_eq!(text_of(foreign).as_deref(), Some("set-by-foreign"));

    wayland.clear(&lease()).expect("a clear");
    let nothing = world.foreign(PASTE, &["--list-types"], None);
    assert!(
        matches!(nothing, RunOutcome::Exited { code: Some(1), ref stderr, .. } if stderr.contains("Nothing is copied"))
    );
}

#[test]
#[ignore = "boots a private headless gnome-shell; run inside scripts/private-session.sh"]
fn images_and_file_lists_round_trip() {
    let world = boot();
    let wayland = world.wayland();
    let lease = || {
        InteractionLease::guarded(Deadline::after(8_000).expect("a deadline"), ()).expect("a lease")
    };
    let picture = ClipboardContent::Image(ImageBuffer {
        data: png(),
        format: ImageFormat::Png,
        width: 2,
        height: 3,
        scale_factor: 1.0,
    });
    wayland.set(&picture, &lease()).expect("an image set");
    let back = wayland
        .read(ClipboardFormat::Image, Deadline::after(8_000).unwrap())
        .expect("a read");
    assert!(matches!(back, Some(ClipboardContent::Image(ref got)) if got.data == png()));
    let files = ClipboardContent::FileUrls(vec!["/tmp/a b".into(), "/tmp/c".into()]);
    wayland.set(&files, &lease()).expect("a file set");
    let back = wayland
        .read(ClipboardFormat::FileUrls, Deadline::after(8_000).unwrap())
        .expect("a read");
    assert!(
        matches!(back, Some(ClipboardContent::FileUrls(ref paths)) if paths == &["/tmp/a b", "/tmp/c"])
    );
    let listed = stdout_of(world.foreign(PASTE, &["--list-types"], None));
    assert!(listed.contains("text/uri-list"));
    assert!(
        !listed.contains("image/png"),
        "a file set must replace the image offer"
    );
}
use crate::input::clipboard::command_runner::ProcessRunner;
