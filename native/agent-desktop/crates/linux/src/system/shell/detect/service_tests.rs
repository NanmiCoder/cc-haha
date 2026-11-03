use super::runs_shell_service;

fn argv(parts: &[&str]) -> Vec<String> {
    parts.iter().map(|part| (*part).to_owned()).collect()
}

#[test]
fn the_shells_service_module_is_recognised_by_its_path() {
    assert!(runs_shell_service(&argv(&[
        "gjs",
        "-m",
        "/usr/share/gnome-shell/org.gnome.Shell.Notifications",
    ])));
}

#[test]
fn another_daemon_or_a_look_alike_path_is_not_the_shells_service() {
    for parts in [
        &["/usr/bin/kded6"][..],
        &["gjs", "-m", "/tmp/org.gnome.Shell.Notifications"],
        &["gjs", "-m", "org.gnome.Shell.Notifications"],
        &["gjs", "/usr/share/gnome-shell/org.gnome.Shell.Screencast"],
    ] {
        assert!(!runs_shell_service(&argv(parts)), "{parts:?}");
    }
}
