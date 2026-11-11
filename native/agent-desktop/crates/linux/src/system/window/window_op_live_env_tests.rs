use std::collections::BTreeSet;
use std::os::unix::fs::DirBuilderExt;
use std::os::unix::process::CommandExt;
use std::path::PathBuf;
use std::process::{Child, Stdio};

use super::*;

const CHILD_MARKER: &str = "AGENT_DESKTOP_WINDOW_OP_CHILD";

#[path = "window_op_no_display_live_tests.rs"]
mod no_display;

fn in_child(test: &str, configure: impl FnOnce(&mut Command)) {
    let mut command = Command::new(std::env::current_exe().expect("the test binary"));
    command
        .args([
            "--exact",
            &format!("system::window::window_op_live_tests::environment::{test}"),
            "--include-ignored",
            "--nocapture",
            "--test-threads=1",
        ])
        .env(CHILD_MARKER, "1");
    configure(&mut command);
    let output = command.output().expect("the child test runs");
    let stdout = String::from_utf8_lossy(&output.stdout);
    println!("{stdout}");
    assert!(output.status.success(), "the child test failed");
    assert!(
        stdout.contains("1 passed; 0 failed"),
        "{test} must execute exactly one test: {output:?}"
    );
}

fn child_window(bus: &SharedBus, launched: &mut Launched) -> WindowInfo {
    let pid = spawn(launched, "gtk3");
    wait_for(bus, pid)
}

#[test]
#[ignore = "drives real desktop applications; run through scripts/linux-live-gate.sh"]
fn window_op_live_a_stale_wayland_display_still_proceeds_on_x11() {
    in_child("window_op_live_child_stale_wayland", |command| {
        command.env("WAYLAND_DISPLAY", "/nonexistent/wayland-socket");
    });
}

#[test]
#[ignore = "runs only inside the parent test that sets its environment"]
fn window_op_live_child_stale_wayland() {
    if std::env::var_os(CHILD_MARKER).is_none() {
        return;
    }
    let bus = SharedBus::default();
    let mut launched = Launched::new();
    let window = child_window(&bus, &mut launched);
    let xid = xid_of(window.pid.get());
    apply(&window, WindowOp::Move { x: 60.0, y: 70.0 }).expect("the move proceeds on X11");
    let placed = geometry(&xid);
    assert!(near(placed.x, 60) && near(placed.y, 70));
}

fn names_in(dir: &std::path::Path, prefix: &str) -> BTreeSet<String> {
    std::fs::read_dir(dir)
        .map(|entries| {
            entries
                .flatten()
                .filter_map(|entry| entry.file_name().into_string().ok())
                .filter(|name| name.starts_with(prefix) && !name.ends_with(".lock"))
                .collect()
        })
        .unwrap_or_default()
}

fn xwayland_display(shell: u32) -> Option<(String, String)> {
    let listed = text("ps", &["-o", "args=", "--ppid", &shell.to_string()]);
    listed.lines().find_map(|line| {
        let words: Vec<&str> = line.split_whitespace().collect();
        words
            .first()
            .filter(|program| program.ends_with("Xwayland"))?;
        let display = words.get(1).filter(|name| name.starts_with(':'))?;
        let auth = words.iter().position(|word| *word == "-auth")?;
        Some(((*display).to_owned(), (*words.get(auth + 1)?).to_owned()))
    })
}

fn answers(display: &str, authority: &str) -> bool {
    let Ok(mut probe) = Command::new("xprop")
        .args(["-display", display, "-root", "_NET_SUPPORTING_WM_CHECK"])
        .env("XAUTHORITY", authority)
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()
    else {
        return false;
    };
    let until = Instant::now() + Duration::from_secs(6);
    while Instant::now() < until {
        if let Ok(Some(_)) = probe.try_wait() {
            let mut text = String::new();
            if let Some(mut out) = probe.stdout.take() {
                let _ = std::io::Read::read_to_string(&mut out, &mut text);
            }
            return text.contains("window id");
        }
        std::thread::sleep(Duration::from_millis(100));
    }
    let _ = probe.kill();
    let _ = probe.wait();
    false
}

struct InnerSession {
    dir: PathBuf,
    bus: Child,
}

impl InnerSession {
    fn start() -> Self {
        assert!(
            std::env::var_os("AGENT_DESKTOP_PRIVATE_SESSION").is_some(),
            "refusing to start a compositor outside a private session"
        );
        let base = std::env::var_os("AGENT_DESKTOP_SESSION_BASE")
            .filter(|value| !value.is_empty())
            .map(PathBuf::from)
            .unwrap_or_else(|| {
                std::env::var_os("XDG_RUNTIME_DIR")
                    .filter(|value| !value.is_empty())
                    .map(|runtime| PathBuf::from(runtime).join("agent-desktop-sessions"))
                    .unwrap_or_else(|| {
                        PathBuf::from(format!("/tmp/agent-desktop-sessions-{}", unsafe {
                            libc::getuid()
                        }))
                    })
            });
        let nanos = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map_or(0, |elapsed| elapsed.as_nanos());
        let dir = base.join(format!("rt.xw{}-{nanos}", std::process::id()));
        std::fs::DirBuilder::new()
            .recursive(true)
            .mode(0o700)
            .create(&dir)
            .expect("a private runtime directory");
        let settings = dir.join("cfg/glib-2.0/settings");
        std::fs::create_dir_all(&settings).expect("a settings directory");
        std::fs::write(
            settings.join("keyfile"),
            "[org/gnome/desktop/interface]\ntoolkit-accessibility=true\n",
        )
        .expect("a settings file");
        let socket = dir.join("bus");
        let mut daemon = Command::new("dbus-daemon");
        daemon
            .args(["--session", "--nofork"])
            .arg(format!("--address=unix:path={}", socket.display()))
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null());
        Self::isolate(&mut daemon, &dir);
        let bus = daemon.spawn().expect("a session bus");
        let session = Self { dir, bus };
        let until = Instant::now() + Duration::from_secs(10);
        while !socket.exists() && Instant::now() < until {
            std::thread::sleep(Duration::from_millis(100));
        }
        assert!(socket.exists(), "the inner session bus did not start");
        session
    }

    fn isolate(command: &mut Command, dir: &std::path::Path) {
        command
            .env_remove("DISPLAY")
            .env_remove("WAYLAND_DISPLAY")
            .env_remove("XAUTHORITY")
            .env_remove("AT_SPI_BUS_ADDRESS")
            .env("XDG_RUNTIME_DIR", dir)
            .env("XDG_CONFIG_HOME", dir.join("cfg"))
            .env("XDG_DATA_HOME", dir.join("data"))
            .env("XDG_CACHE_HOME", dir.join("cache"))
            .env("GSETTINGS_BACKEND", "keyfile")
            .env("XDG_CURRENT_DESKTOP", "GNOME")
            .env(
                "DBUS_SESSION_BUS_ADDRESS",
                format!("unix:path={}", dir.join("bus").display()),
            );
    }

    fn configure(&self, command: &mut Command) {
        Self::isolate(command, &self.dir);
    }

    fn members(&self) -> Vec<u32> {
        let marker = format!("XDG_RUNTIME_DIR={}", self.dir.display());
        std::fs::read_dir("/proc")
            .into_iter()
            .flatten()
            .flatten()
            .filter_map(|entry| entry.file_name().to_str()?.parse::<u32>().ok())
            .filter(|pid| {
                std::fs::read(format!("/proc/{pid}/environ")).is_ok_and(|bytes| {
                    bytes
                        .split(|byte| *byte == 0)
                        .any(|e| e == marker.as_bytes())
                })
            })
            .collect()
    }
}

impl Drop for InnerSession {
    fn drop(&mut self) {
        for signal in ["-TERM", "-KILL"] {
            for pid in self.members() {
                let _ = Command::new("kill")
                    .args([signal, &pid.to_string()])
                    .stderr(Stdio::null())
                    .status();
            }
            std::thread::sleep(Duration::from_secs(1));
        }
        let _ = self.bus.kill();
        let _ = self.bus.wait();
        let _ = std::fs::remove_dir_all(&self.dir);
    }
}

struct Compositor {
    session: InnerSession,
    child: Child,
    socket: String,
    display: String,
    authority: String,
}

impl Compositor {
    fn start() -> Option<Self> {
        let session = InnerSession::start();
        let log = std::fs::File::create(session.dir.join("window-op-shell.log")).ok()?;
        let mut command = Command::new("gnome-shell");
        command
            .args(["--headless", "--wayland", "--virtual-monitor", "1280x800"])
            .stdin(Stdio::null())
            .stdout(log.try_clone().ok()?)
            .stderr(log)
            .process_group(0);
        session.configure(&mut command);
        let child = command.spawn().ok()?;
        let mut shell = Self {
            session,
            child,
            socket: String::new(),
            display: String::new(),
            authority: String::new(),
        };
        let until = Instant::now() + Duration::from_secs(25);
        while Instant::now() < until && (shell.socket.is_empty() || shell.display.is_empty()) {
            if let Some(new) = names_in(&shell.session.dir, "wayland-").iter().next() {
                shell.socket.clone_from(new);
            }
            if let Some((display, authority)) = xwayland_display(shell.child.id()) {
                shell.display = display;
                shell.authority = authority;
            }
            std::thread::sleep(Duration::from_millis(200));
        }
        std::thread::sleep(Duration::from_secs(8));
        let answered = !shell.socket.is_empty()
            && !shell.display.is_empty()
            && (0..3).any(|_| answers(&shell.display, &shell.authority));
        answered.then_some(shell)
    }
}

impl Drop for Compositor {
    fn drop(&mut self) {
        let group = format!("-{}", self.child.id());
        let _ = Command::new("kill")
            .args(["-KILL", "--", &group])
            .stderr(Stdio::null())
            .status();
        let _ = self.child.kill();
        let _ = self.child.wait();
        std::thread::sleep(Duration::from_secs(2));
    }
}

#[test]
#[ignore = "drives real desktop applications; run through scripts/linux-live-gate.sh"]
fn window_op_live_an_xwayland_window_is_operated_and_a_native_wayland_window_is_refused() {
    let shell = (0..5)
        .find_map(|_| Compositor::start())
        .expect("a headless gnome-shell with an Xwayland answers");
    in_child("window_op_live_child_xwayland", |command| {
        shell.session.configure(command);
        command
            .env("WAYLAND_DISPLAY", &shell.socket)
            .env("DISPLAY", &shell.display)
            .env("XAUTHORITY", &shell.authority);
    });
}

#[test]
#[ignore = "runs only inside the parent test that sets its environment"]
fn window_op_live_child_xwayland() {
    if std::env::var_os(CHILD_MARKER).is_none() {
        return;
    }
    let bus = SharedBus::default();
    let mut launched = Launched::new();
    let x11 = launched.spawn_with_env(
        "python3",
        &[&script_path("adx-gtk3", GTK3)],
        &[("GDK_BACKEND", "x11".to_owned())],
    );
    let window = wait_for(&bus, x11);
    let xid = xid_of(x11);
    std::thread::sleep(Duration::from_millis(1_500));
    apply(
        &window,
        WindowOp::Resize {
            width: 500.0,
            height: 380.0,
        },
    )
    .expect("a resize");
    let sized = geometry(&xid);
    assert!(
        near(sized.width, 500) && near(sized.height, 380),
        "{sized:?}"
    );
    apply(&window, WindowOp::Move { x: 120.0, y: 90.0 }).expect("a move");
    let moved = geometry(&xid);
    assert!(near(moved.x, 120) && near(moved.y, 90), "{moved:?}");
    apply(&window, WindowOp::Maximize).expect("a maximize");
    assert_eq!(maximized(&xid), (true, true));
    apply(&window, WindowOp::Restore).expect("a restore from maximized");
    assert_eq!(maximized(&xid), (false, false));
    let restored = geometry(&xid);
    assert!(
        near(restored.x, 120) && near(restored.y, 90),
        "{restored:?}"
    );
    apply(&window, WindowOp::Minimize).expect("a minimize");
    wait_until("the window is hidden", || hidden(&xid));
    let refused = apply(&window, WindowOp::Restore).expect_err("un-minimize is refused");
    assert_eq!(refused.code, ErrorCode::ActionNotSupported);
    assert_eq!(
        refused.details.as_ref().expect("details")["cause"],
        "wayland_session"
    );
    assert!(hidden(&xid), "a refusal leaves the window hidden");

    let native = launched.spawn_with_env(
        "python3",
        &[&script_path("adx-gtk4", GTK4)],
        &[("GDK_BACKEND", "wayland".to_owned())],
    );
    let native_window = wait_for(&bus, native);
    let error = apply(&native_window, WindowOp::Minimize).expect_err("a native window is refused");
    assert_eq!(error.code, ErrorCode::ActionNotSupported);
    assert_eq!(
        error.details.as_ref().expect("details")["cause"],
        "wayland_session"
    );
    assert_eq!(error.disposition, DeliverySemantics::not_delivered());

    let app = agent_desktop_core::AppInfo {
        name: "adw-native".to_owned(),
        pid: native.into(),
        bundle_id: None,
        process_instance: native_window.process_instance.clone(),
        presentation: None,
    };
    let lease = acquire(deadline(8_000)).expect("a lease");
    let closed = crate::system::close::close_app(&bus, &app, false, &lease)
        .expect_err("a native Wayland window has no close request");
    assert_eq!(closed.code, ErrorCode::ActionNotSupported);
    assert_eq!(
        closed.details.as_ref().expect("details")["cause"],
        "wayland_session"
    );
    assert_eq!(closed.disposition, DeliverySemantics::not_delivered());
    assert!(
        std::path::Path::new(&format!("/proc/{native}")).exists(),
        "a refusal leaves the app running"
    );
}
