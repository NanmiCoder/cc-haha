use std::collections::BTreeMap;

use super::*;

const HANDOFF_APP: &str = r#"
import os, sys
if '--daemon' not in sys.argv:
    with open(os.environ['ADL_REQUEST'], 'w') as request:
        request.write('open')
    sys.exit(0)
import gi
gi.require_version('Gtk', '3.0')
from gi.repository import Gtk, GLib
Gtk.init()
windows = []
def open_window():
    window = Gtk.Window(title='adl-handoff-' + str(len(windows)))
    window.set_default_size(200, 100)
    window.show_all()
    windows.append(window)
    return False
open_window()
def receive():
    if not os.path.exists(os.environ['ADL_REQUEST']):
        return True
    GLib.timeout_add(1600, open_window)
    return False
GLib.timeout_add(20, receive)
GLib.timeout_add(60000, Gtk.main_quit)
Gtk.main()
"#;

/// Embeds Python so the fixture retains its own canonical executable in /proc.
const PYTHON_SHIM: &str = r#"
#include <dlfcn.h>
#include <stdlib.h>
int main(int argc, char **argv) {
    void *python = dlopen(getenv("ADL_PYTHON_LIBRARY"), RTLD_NOW | RTLD_GLOBAL);
    if (!python) return 1;
    int (*run)(int, char **) = dlsym(python, "Py_BytesMain");
    if (!run) return 2;
    char *args[argc + 2];
    args[0] = "/usr/bin/python3";
    args[1] = getenv("ADL_PYTHON_SCRIPT");
    for (int i = 1; i < argc; i++) args[i + 1] = argv[i];
    args[argc + 1] = NULL;
    return run(argc + 1, args);
}
"#;

fn listed_windows(pid: u32) -> Vec<agent_desktop_core::WindowInfo> {
    crate::system::list_windows(
        &SharedBus::default(),
        &agent_desktop_core::WindowFilter::default(),
        deadline(8_000),
    )
    .expect("windows can be listed")
    .into_iter()
    .filter(|window| window.pid.get() == pid)
    .collect()
}

#[test]
#[ignore = "drives real applications; run through scripts/private-session.sh --wm"]
fn live_a_clean_launcher_hands_off_to_a_resident_with_different_arguments() {
    let dir = std::env::var("AGENT_DESKTOP_PRIVATE_SESSION").expect("a private session");
    let script = format!("{dir}/adl-handoff");
    let python_script = format!("{script}.py");
    let source = format!("{script}.c");
    let request = format!("{script}.request");
    assert!(
        !std::path::Path::new(&request).exists(),
        "a fresh request path"
    );
    std::fs::write(&python_script, HANDOFF_APP).expect("a Python script");
    std::fs::write(&source, PYTHON_SHIM).expect("an embedding shim");
    assert!(
        Command::new("cc")
            .args([&source, "-o", &script, "-ldl"])
            .status()
            .expect("cc runs")
            .success()
    );
    let library = Command::new("/usr/bin/python3")
        .args(["-c", "import ctypes.util, sysconfig; library = ctypes.util.find_library('python' + sysconfig.get_python_version()); assert library, 'a shared Python runtime is required'; print(library)"])
        .output()
        .expect("Python locates its shared library");
    assert!(library.status.success());
    let env = [
        ("ADL_REQUEST", request.clone()),
        ("ADL_PYTHON_SCRIPT", python_script),
        (
            "ADL_PYTHON_LIBRARY",
            String::from_utf8(library.stdout).unwrap().trim().to_owned(),
        ),
    ];
    let resident =
        crate::system::close::close_live_tests::rig::Orphan::spawn(&script, &["--daemon"], &env);
    resident.wait_for_window();
    wait_until("the resident on the accessibility bus", || {
        registry_has(resident.pid)
    });
    let before = listed_windows(resident.pid);
    assert_eq!(before.len(), 1);
    let native_before = x_windows_of(resident.pid);
    assert_eq!(native_before.len(), 1);
    let facts = process_facts::read(resident.pid).expect("resident process facts");
    assert_eq!(
        facts.executable.as_ref().unwrap().executable,
        std::fs::canonicalize(&script).unwrap()
    );
    let result = launch(
        &script,
        &LaunchOptions {
            activate: true,
            env: env
                .into_iter()
                .map(|(key, value)| (key.to_owned(), value))
                .collect::<BTreeMap<_, _>>(),
            ..options(&[])
        },
    )
    .expect("the resident's delayed new window proves the handoff");
    assert_eq!(result.pid.get(), resident.pid);
    assert_eq!(
        result.process_instance.as_deref(),
        Some(facts.instance.as_str())
    );
    let window = result.window.expect("a new window is reported");
    assert_eq!(window.pid.get(), resident.pid);
    assert!(!before.iter().any(|old| old.id == window.id));
    assert!(
        listed_windows(resident.pid)
            .iter()
            .any(|live| live.id == window.id)
    );
    wait_until("an independently observed new native window", || {
        x_windows_of(resident.pid)
            .iter()
            .any(|id| !native_before.contains(id))
    });
    assert!(
        native_before
            .iter()
            .all(|id| x_windows_of(resident.pid).contains(id))
    );
    assert!(std::path::Path::new(&request).exists());
}
