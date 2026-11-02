use std::os::unix::process::CommandExt;
use std::process::{Child, Command, Stdio};

use super::wayland_portal_live_support::runtime_dir;

pub(super) struct Group(Child);

impl Drop for Group {
    fn drop(&mut self) {
        let group = format!("-{}", self.0.id());
        let _ = Command::new("kill").args(["-KILL", "--", &group]).status();
        let _ = self.0.kill();
        let _ = self.0.wait();
    }
}

pub(super) fn spawn(
    program: &str,
    args: &[&str],
    env: &[(&str, &str)],
    log: &str,
) -> Option<Group> {
    let home = runtime_dir().join("portal-home");
    std::fs::create_dir_all(&home).ok()?;
    let log = std::fs::File::create(runtime_dir().join(log)).ok()?;
    let mut command = Command::new(program);
    command
        .args(args)
        .env_remove("DISPLAY")
        .env_remove("WAYLAND_DISPLAY")
        .env("HOME", home)
        .envs(env.iter().copied())
        .stdin(Stdio::null())
        .stdout(log.try_clone().ok()?)
        .stderr(log)
        .process_group(0);
    Some(Group(command.spawn().ok()?))
}
