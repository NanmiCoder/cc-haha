use super::*;

fn entry(id: &str, exec: &str, extra: &str) {
    let data = std::env::var("XDG_DATA_HOME").expect("private data");
    let entries = std::path::Path::new(&data).join("applications");
    std::fs::create_dir_all(&entries).expect("entries");
    std::fs::write(
        entries.join(format!("{id}.desktop")),
        format!("[Desktop Entry]\nType=Application\nName={id}\nExec={exec}\n{extra}"),
    )
    .expect("entry");
}

#[test]
#[ignore = "runs native GTK apps; use an owned X11 or Wayland private session"]
fn executable_identity_attaches_only_the_real_path_and_its_verified_alias() {
    let runtime = std::path::PathBuf::from(
        std::env::var("AGENT_DESKTOP_PRIVATE_SESSION").expect("private session"),
    );
    let source = runtime.join("identity-app.c");
    std::fs::write(
        &source,
        r#"
extern void gtk_init(int*, char***);
extern void* gtk_window_new(int);
extern void gtk_window_set_title(void*, const char*);
extern void gtk_widget_show_all(void*);
extern void gtk_main(void);
int main(int argc, char** argv) {
    gtk_init(&argc, &argv);
    void* window = gtk_window_new(0);
    gtk_window_set_title(window, argv[0]);
    gtk_widget_show_all(window);
    gtk_main();
}
"#,
    )
    .unwrap();
    let a = runtime.join("a");
    let b = runtime.join("b");
    std::fs::create_dir_all(&a).unwrap();
    std::fs::create_dir_all(&b).unwrap();
    let other_path = a.join("editor");
    let target_path = b.join("editor");
    assert!(
        Command::new("cc")
            .arg(&source)
            .args(["-o"])
            .arg(&other_path)
            .arg("-l:libgtk-3.so.0")
            .status()
            .unwrap()
            .success()
    );
    std::fs::copy(&other_path, &target_path).unwrap();
    let invocation_path = b.join("editor-invocation");
    std::os::unix::fs::symlink(&target_path, &invocation_path).unwrap();
    entry(
        "ad-path-editor",
        target_path.to_str().unwrap(),
        "TryExec=/usr/bin/python3\n",
    );
    let mut owned = Owned(Vec::new());
    for _ in 0..2 {
        let other = launch(other_path.to_str().unwrap(), &options(&[])).expect("other app starts");
        owned.keep(other.pid.get());
        assert_native_window(other.pid.get(), other_path.to_str().unwrap());
        let alias = crate::system::app::app_ops::scoped(
            &SharedBus::default(),
            "ad-path-editor",
            None,
            deadline(5000),
        )
        .unwrap();
        assert!(
            alias.is_empty(),
            "same basename must not acquire the requested alias"
        );
        let refused = agent_desktop_core::commands::close_app::execute(
            agent_desktop_core::commands::close_app::CloseAppArgs {
                app: "ad-path-editor".into(),
                force: false,
            },
            &crate::LinuxAdapter::new(),
        )
        .expect_err("unverified alias refuses close before delivery");
        assert_eq!(refused.code(), "APP_NOT_FOUND");
        assert_native_window(other.pid.get(), other_path.to_str().unwrap());
        let target =
            launch(target_path.to_str().unwrap(), &options(&[])).expect("requested path starts");
        owned.keep(target.pid.get());
        assert_ne!(target.pid, other.pid);
        assert_eq!(
            std::fs::canonicalize(format!("/proc/{}/exe", target.pid)).unwrap(),
            target_path
        );
        assert_native_window(target.pid.get(), target_path.to_str().unwrap());
        for request in [target_path.to_str().unwrap(), "ad-path-editor"] {
            let again = launch(request, &options(&[])).expect("verified process attaches");
            assert_eq!(again.pid, target.pid);
            let refused = launch(
                request,
                &LaunchOptions {
                    attach_if_running: false,
                    ..options(&[])
                },
            )
            .expect_err("already running refuses fresh launch");
            assert_eq!(refused.code, ErrorCode::ActionFailed);
            assert_eq!(
                refused.disposition,
                agent_desktop_core::DeliverySemantics::not_delivered()
            );
        }
        let alias = crate::system::app::app_ops::scoped(
            &SharedBus::default(),
            "ad-path-editor",
            None,
            deadline(5000),
        )
        .unwrap();
        assert_eq!(
            alias.iter().map(|app| app.pid.get()).collect::<Vec<_>>(),
            [target.pid.get()]
        );
        entry(
            "ad-path-editor",
            other_path.to_str().unwrap(),
            "TryExec=/usr/bin/python3\n",
        );
        let edited = crate::system::app::app_ops::scoped(
            &SharedBus::default(),
            "ad-path-editor",
            None,
            deadline(5000),
        )
        .unwrap();
        assert_eq!(
            edited.iter().map(|app| app.pid.get()).collect::<Vec<_>>(),
            [other.pid.get()],
            "an in-place desktop edit cannot retain the previous process alias"
        );
        assert_eq!(
            launch("ad-path-editor", &options(&[])).unwrap().pid,
            other.pid
        );
        assert_native_window(other.pid.get(), other_path.to_str().unwrap());
        assert_native_window(target.pid.get(), target_path.to_str().unwrap());
        entry(
            "ad-path-editor",
            target_path.to_str().unwrap(),
            "TryExec=/usr/bin/python3\n",
        );
        entry("ad-invoked-editor", invocation_path.to_str().unwrap(), "");
        assert!(
            crate::system::app::app_ops::scoped(
                &SharedBus::default(),
                "ad-invoked-editor",
                None,
                deadline(5000),
            )
            .unwrap()
            .is_empty(),
            "an argv[0] alias is not the same invocation"
        );
        let invoked = launch("ad-invoked-editor", &options(&[])).unwrap();
        owned.keep(invoked.pid.get());
        assert_ne!(invoked.pid, target.pid);
        assert_eq!(
            std::fs::canonicalize(format!("/proc/{}/exe", invoked.pid)).unwrap(),
            target_path
        );
        assert_native_window(invoked.pid.get(), invocation_path.to_str().unwrap());
        assert_native_window(target.pid.get(), target_path.to_str().unwrap());
        assert_eq!(
            launch("ad-invoked-editor", &options(&[])).unwrap().pid,
            invoked.pid
        );
        let refused = launch(
            "ad-invoked-editor",
            &LaunchOptions {
                attach_if_running: false,
                ..options(&[])
            },
        )
        .unwrap_err();
        assert_eq!(refused.code, ErrorCode::ActionFailed);
        assert_eq!(
            refused.disposition,
            agent_desktop_core::DeliverySemantics::not_delivered()
        );
        println!(
            "independent python Atspi + /proc: {} at {} != {} at {}; exact path and desktop alias reattach only the target",
            other.pid,
            other_path.display(),
            target.pid,
            target_path.display()
        );
        for pid in [other.pid.get(), target.pid.get(), invoked.pid.get()] {
            kill_quietly(pid);
            wait_until("owned app exits", || process_facts::read(pid).is_none());
        }
        owned.0.clear();
    }
}

fn assert_native_window(pid: u32, title: &str) {
    let output = Command::new("python3").args(["-c", r#"
import gi, sys, time
gi.require_version('Atspi', '2.0')
from gi.repository import Atspi
end = time.monotonic() + 10
while time.monotonic() < end:
    desktop = Atspi.get_desktop(0)
    for i in range(desktop.get_child_count()):
        app = desktop.get_child_at_index(i)
        if app.get_process_id() != int(sys.argv[1]): continue
        for j in range(app.get_child_count()):
            window = app.get_child_at_index(j)
            if window.get_name() == sys.argv[2] and window.get_state_set().contains(Atspi.StateType.SHOWING):
                print('independent Atspi window', sys.argv[1], window.get_name())
                sys.exit(0)
    time.sleep(0.1)
sys.exit(1)
"#, &pid.to_string(), title]).output().unwrap();
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    print!("{}", String::from_utf8_lossy(&output.stdout));
}
