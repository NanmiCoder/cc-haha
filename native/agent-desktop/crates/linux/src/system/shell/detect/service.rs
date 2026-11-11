use std::os::unix::fs::MetadataExt;
use std::path::Path;

const SERVICE_MODULE: &str = "org.gnome.Shell.Notifications";
const SERVICE_DIRECTORY: &str = "gnome-shell";

/// Whether the argv names the shell's own notification service module: an
/// absolute path to `org.gnome.Shell.Notifications` inside the shell's
/// data directory.
pub(super) fn runs_shell_service(argv: &[String]) -> bool {
    argv.iter().any(|argument| {
        let path = Path::new(argument);
        path.is_absolute()
            && path.file_name().is_some_and(|name| name == SERVICE_MODULE)
            && path
                .parent()
                .and_then(Path::file_name)
                .is_some_and(|directory| directory == SERVICE_DIRECTORY)
    })
}

fn argv_of(pid: u32) -> Option<Vec<String>> {
    let raw = std::fs::read(format!("/proc/{pid}/cmdline")).ok()?;
    Some(
        raw.split(|byte| *byte == 0)
            .filter(|part| !part.is_empty())
            .map(|part| String::from_utf8_lossy(part).into_owned())
            .collect(),
    )
}

fn user_of(pid: u32) -> Option<u32> {
    std::fs::metadata(format!("/proc/{pid}"))
        .ok()
        .map(|metadata| metadata.uid())
}

/// The shell hands notifications to a helper process it ships and starts, so
/// the bus owner differs from the shell's own. That owner is the shell's
/// service when it runs for the same user as the shell and its argv names the
/// shell's service module.
pub(super) fn is_shell_service(owner: u32, shell: u32) -> bool {
    let same_user = matches!((user_of(owner), user_of(shell)), (Some(a), Some(b)) if a == b);
    same_user && argv_of(owner).is_some_and(|argv| runs_shell_service(&argv))
}

#[cfg(test)]
#[path = "service_tests.rs"]
mod tests;
