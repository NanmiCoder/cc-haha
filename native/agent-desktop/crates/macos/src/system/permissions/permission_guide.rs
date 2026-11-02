use agent_desktop_core::AdapterError;
use std::ffi::{CString, c_char};
use std::fs::File;
use std::os::fd::AsRawFd;
use std::os::unix::process::CommandExt;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::time::{Duration, Instant};

const STEPS_ENV: &str = "AGENT_DESKTOP_PERMISSION_GUIDE";
const HOST_ENV: &str = "AGENT_DESKTOP_PERMISSION_GUIDE_HOST";
const LOCK_ENV: &str = "AGENT_DESKTOP_PERMISSION_GUIDE_LOCK";
const PROBE_ENV: &str = "AGENT_DESKTOP_PERMISSION_GUIDE_PROBE";
const LOCK_NAME: &str = "agent-desktop-permission-guide.lock";
const ACCESSIBILITY: u8 = 1;
const SCREEN_RECORDING: u8 = 2;
const PROBE_TIMEOUT: Duration = Duration::from_secs(3);
const MAX_ANCESTORS: usize = 64;
const COMMAND_HOST_ENVS: [&str; 3] = [
    "AGENT_DESKTOP_INTERNAL_COMMAND_HOST",
    "AGENT_DESKTOP_INTERNAL_HOST_SOCKET",
    "AGENT_DESKTOP_INTERNAL_HOST_CLIENT",
];

pub(crate) fn start() -> Result<&'static str, AdapterError> {
    let steps = missing_steps(
        crate::system::permissions::preflight_accessibility(),
        crate::system::permissions::preflight_screen_recording(),
    );
    if steps == 0 {
        return Ok("not_needed");
    }
    let lock = match single_instance_lock() {
        Ok(Some(lock)) => lock,
        Ok(None) => return Ok("already_running"),
        Err(error) => {
            return Err(
                AdapterError::internal("Could not open the permission guide lock")
                    .with_platform_detail(error.to_string()),
            );
        }
    };
    let executable = std::env::current_exe().map_err(|error| {
        AdapterError::internal("Could not locate the agent-desktop executable")
            .with_platform_detail(error.to_string())
    })?;
    let host = host_app().unwrap_or_else(|| executable.clone());
    let mut command = Command::new(&executable);
    for name in COMMAND_HOST_ENVS {
        command.env_remove(name);
    }
    hand_over(&mut command, &lock);
    let mut child = command
        .env(STEPS_ENV, steps.to_string())
        .env(HOST_ENV, host)
        .process_group(0)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
        .map_err(|error| {
            AdapterError::internal("Could not start the macOS permission guide")
                .with_platform_detail(error.to_string())
        })?;
    std::thread::spawn(move || child.wait());
    Ok("started")
}

pub fn entry_from_env() -> Option<u8> {
    if let Ok(step) = std::env::var(PROBE_ENV) {
        return Some(if probe(&step) { 0 } else { 1 });
    }
    let steps = std::env::var(STEPS_ENV).ok()?;
    Some(if run_child(&steps) { 0 } else { 1 })
}

fn run_child(steps: &str) -> bool {
    let Some(steps) = parse_steps(steps) else {
        return false;
    };
    let Some(host) = std::env::var(HOST_ENV)
        .ok()
        .filter(|path| std::path::Path::new(path).exists())
        .and_then(|path| CString::new(path).ok())
    else {
        return false;
    };
    if !keep_inherited_lock() {
        return false;
    }
    unsafe { agent_desktop_permission_guide_run(steps, host.as_ptr(), granted) == 0 }
}

/// Each poll runs in a fresh process: a long-lived process keeps the Screen
/// Recording answer it read at launch, and the command host may belong to
/// another terminal app.
extern "C" fn granted(step: u8) -> bool {
    let Ok(executable) = std::env::current_exe() else {
        return false;
    };
    let mut command = Command::new(executable);
    command
        .env_remove(STEPS_ENV)
        .env(PROBE_ENV, step.to_string());
    crate::system::process::run_with_deadline(
        &mut command,
        "macOS permission guide probe",
        Instant::now() + PROBE_TIMEOUT,
    )
    .is_ok_and(|output| output.status.success())
}

fn probe(step: &str) -> bool {
    match step.parse::<u8>() {
        Ok(ACCESSIBILITY) => crate::system::permissions::preflight_accessibility(),
        Ok(SCREEN_RECORDING) => crate::system::permissions::preflight_screen_recording(),
        _ => false,
    }
}

fn missing_steps(accessibility: bool, screen_recording: bool) -> u8 {
    let mut steps = 0;
    if !accessibility {
        steps |= ACCESSIBILITY;
    }
    if !screen_recording {
        steps |= SCREEN_RECORDING;
    }
    steps
}

fn parse_steps(value: &str) -> Option<u8> {
    value
        .parse::<u8>()
        .ok()
        .filter(|steps| (1..=(ACCESSIBILITY | SCREEN_RECORDING)).contains(steps))
}

/// TCC charges a command-line tool to the app that launched its process
/// tree, so the guide shows the nearest ancestor that runs from an app
/// bundle. Terminal servers such as Rex Server are not registered with
/// LaunchServices, so the bundle comes from the executable path.
fn host_app() -> Option<PathBuf> {
    let mut pid = i32::try_from(std::process::id()).ok()?;
    for _ in 0..MAX_ANCESTORS {
        if pid <= 1 {
            return None;
        }
        let app = crate::system::renderer_kind::executable_path(pid)
            .as_deref()
            .and_then(outermost_app);
        if app.is_some() {
            return app;
        }
        pid = parent_pid(pid)?;
    }
    None
}

/// A helper such as `Code Helper (Plugin).app` sits inside the app that TCC
/// names, so the outermost bundle wins.
fn outermost_app(executable: &Path) -> Option<PathBuf> {
    executable
        .ancestors()
        .filter(|path| path.extension().is_some_and(|extension| extension == "app"))
        .last()
        .map(Path::to_path_buf)
}

/// The short BSD record, unlike the full one, is readable for processes of
/// another user, such as the root-owned `/usr/bin/login` a terminal starts.
fn parent_pid(pid: i32) -> Option<i32> {
    let mut info = std::mem::MaybeUninit::<libc::proc_bsdshortinfo>::zeroed();
    let size = i32::try_from(std::mem::size_of::<libc::proc_bsdshortinfo>()).ok()?;
    let read = unsafe {
        libc::proc_pidinfo(
            pid,
            libc::PROC_PIDT_SHORTBSDINFO,
            0,
            info.as_mut_ptr().cast(),
            size,
        )
    };
    if read != size {
        return None;
    }
    i32::try_from(unsafe { info.assume_init() }.pbsi_ppid).ok()
}

fn hand_over(command: &mut Command, lock: &File) {
    let fd = lock.as_raw_fd();
    command.env(LOCK_ENV, fd.to_string());
    unsafe {
        command.pre_exec(move || {
            if libc::fcntl(fd, libc::F_SETFD, 0) == -1 {
                return Err(std::io::Error::last_os_error());
            }
            Ok(())
        });
    }
}

fn keep_inherited_lock() -> bool {
    std::env::var(LOCK_ENV)
        .ok()
        .and_then(|fd| fd.parse::<i32>().ok())
        .is_some_and(|fd| unsafe { libc::fcntl(fd, libc::F_SETFD, libc::FD_CLOEXEC) } == 0)
}

fn single_instance_lock() -> std::io::Result<Option<File>> {
    lock_file(&std::env::temp_dir().join(LOCK_NAME))
}

fn lock_file(path: &Path) -> std::io::Result<Option<File>> {
    let file = File::options()
        .create(true)
        .truncate(false)
        .write(true)
        .open(path)?;
    if unsafe { libc::flock(file.as_raw_fd(), libc::LOCK_EX | libc::LOCK_NB) } == 0 {
        return Ok(Some(file));
    }
    let error = std::io::Error::last_os_error();
    if error.raw_os_error() == Some(libc::EWOULDBLOCK) {
        Ok(None)
    } else {
        Err(error)
    }
}

unsafe extern "C" {
    fn agent_desktop_permission_guide_run(
        steps: u8,
        host_path: *const c_char,
        granted: extern "C" fn(u8) -> bool,
    ) -> i32;
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn guide_covers_only_missing_permissions() {
        assert_eq!(missing_steps(true, true), 0);
        assert_eq!(missing_steps(false, true), ACCESSIBILITY);
        assert_eq!(missing_steps(true, false), SCREEN_RECORDING);
        assert_eq!(
            missing_steps(false, false),
            ACCESSIBILITY | SCREEN_RECORDING
        );
        assert_eq!(parse_steps("3"), Some(3));
        assert_eq!(parse_steps("0"), None);
        assert_eq!(parse_steps("4"), None);
    }

    #[test]
    fn the_guide_lock_stays_held_from_the_check_through_the_child() {
        let path = std::env::temp_dir().join(format!("{LOCK_NAME}.{}.test", std::process::id()));
        let lock = lock_file(&path).unwrap().unwrap();
        let mut command = Command::new("/bin/sleep");
        command.arg("30");
        hand_over(&mut command, &lock);
        let mut child = command.spawn().unwrap();
        drop(lock);
        assert!(lock_file(&path).unwrap().is_none());
        child.kill().unwrap();
        child.wait().unwrap();
        assert!(lock_released_within(&path, Duration::from_secs(10)));
        std::fs::remove_file(&path).unwrap();
    }

    fn lock_released_within(path: &Path, limit: Duration) -> bool {
        let give_up = Instant::now() + limit;
        loop {
            if lock_file(path).unwrap().is_some() {
                return true;
            }
            if Instant::now() >= give_up {
                return false;
            }
            std::thread::sleep(Duration::from_millis(5));
        }
    }

    #[test]
    fn the_guide_offers_the_outermost_app_bundle_of_the_launching_process() {
        let rex = Path::new(
            "/Users/me/Library/Application Support/com.superlogical.rex/RexServer/Versions/Current/Rex Server.app/Contents/MacOS/rex",
        );
        assert_eq!(
            outermost_app(rex),
            Some(PathBuf::from(
                "/Users/me/Library/Application Support/com.superlogical.rex/RexServer/Versions/Current/Rex Server.app"
            ))
        );
        let code_helper = Path::new(
            "/Applications/Visual Studio Code.app/Contents/Frameworks/Code Helper (Plugin).app/Contents/MacOS/Code Helper (Plugin)",
        );
        assert_eq!(
            outermost_app(code_helper),
            Some(PathBuf::from("/Applications/Visual Studio Code.app"))
        );
        assert_eq!(
            outermost_app(Path::new(
                "/System/Applications/Utilities/Terminal.app/Contents/MacOS/Terminal"
            )),
            Some(PathBuf::from("/System/Applications/Utilities/Terminal.app"))
        );
        assert_eq!(
            outermost_app(Path::new("/usr/local/bin/agent-desktop")),
            None
        );
    }

    #[test]
    fn the_host_walk_passes_through_a_process_of_another_user() {
        let parent = parent_pid(i32::try_from(std::process::id()).unwrap());
        assert_eq!(parent, Some(unsafe { libc::getppid() }));
        let launchd_child = std::process::Command::new("/bin/ps")
            .args(["-axo", "pid=,ppid=,uid="])
            .output()
            .unwrap();
        let root_child = String::from_utf8(launchd_child.stdout)
            .unwrap()
            .lines()
            .filter_map(|line| {
                let fields: Vec<i32> = line
                    .split_whitespace()
                    .filter_map(|field| field.parse().ok())
                    .collect();
                (fields.len() == 3 && fields[0] > 1 && fields[1] == 1 && fields[2] == 0)
                    .then_some(fields[0])
            })
            .next()
            .unwrap();
        assert_eq!(parent_pid(root_child), Some(1));
    }
}
