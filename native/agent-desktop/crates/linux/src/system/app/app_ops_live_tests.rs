use agent_desktop_core::{
    Deadline, ObservationOps, SystemOps, system::launch_options::LaunchOptions,
};

use crate::LinuxAdapter;
use crate::system::close::close_live_tests::rig::Orphan;

#[test]
#[ignore = "runs owned GTK desktop entries; use scripts/private-session.sh --wm"]
fn live_desktop_ids_round_trip_through_launch_inventory_selection_and_close() {
    let runtime = std::path::PathBuf::from(std::env::var("AGENT_DESKTOP_PRIVATE_SESSION").unwrap());
    let entries =
        std::path::PathBuf::from(std::env::var("XDG_DATA_HOME").unwrap()).join("applications");
    std::fs::create_dir_all(&entries).unwrap();
    let script = runtime.join("desktop-entry.py");
    std::fs::write(&script, "import gi\ngi.require_version('Gtk','3.0')\nfrom gi.repository import Gtk\nw=Gtk.Window()\nw.connect('destroy',Gtk.main_quit)\nw.show_all()\nGtk.main()\n").unwrap();
    let adapter = LinuxAdapter::new();
    for id in ["org.example.OwnedOne", "org.example.OwnedTwo"] {
        let program = runtime.join(format!("fixture-{id}"));
        std::fs::copy("/usr/bin/python3", &program).unwrap();
        std::fs::write(
            entries.join(format!("{id}.desktop")),
            format!(
                "[Desktop Entry]\nType=Application\nName={id}\nExec={} {}\n",
                program.display(),
                script.display()
            ),
        )
        .unwrap();
        let orphan = Orphan::spawn(program.to_str().unwrap(), &[script.to_str().unwrap()], &[]);
        let ready = std::process::Command::new("python3")
            .args([
                "-c",
                r#"
import gi,sys,time
gi.require_version('Atspi','2.0')
from gi.repository import Atspi
end=time.monotonic()+10
while time.monotonic()<end:
    root=Atspi.get_desktop(0)
    for i in range(root.get_child_count()):
        app=root.get_child_at_index(i)
        if app is None or app.get_process_id()!=int(sys.argv[1]):continue
        for j in range(app.get_child_count()):
            window=app.get_child_at_index(j)
            if window and window.get_state_set().contains(Atspi.StateType.SHOWING):sys.exit(0)
    time.sleep(.05)
sys.exit(1)
"#,
                &orphan.pid.to_string(),
            ])
            .output()
            .unwrap();
        assert!(
            ready.status.success(),
            "{}",
            String::from_utf8_lossy(&ready.stderr)
        );
        let lease = adapter
            .acquire_interaction_lease(Deadline::after(30_000).unwrap())
            .unwrap();
        let launched = adapter
            .launch_app(id, &LaunchOptions::default(), &lease)
            .expect("launch by desktop id");
        assert_eq!(
            launched.pid.get(),
            orphan.pid,
            "attach only the independently ready fixture"
        );
        let apps = adapter
            .list_apps_scoped("", Some(id), lease.deadline())
            .expect("select by bundle id");
        assert_eq!(apps.len(), 1, "one app for {id}");
        let app = &apps[0];
        assert_eq!(app.pid, launched.pid);
        assert_eq!(app.bundle_id.as_deref(), Some(id));
        let by_name = adapter
            .list_apps_scoped(id, None, lease.deadline())
            .expect("same identifier as name");
        assert_eq!(by_name.len(), 1);
        assert_eq!(by_name[0].pid, app.pid);
        assert_eq!(by_name[0].bundle_id, app.bundle_id);
        let executable = std::fs::read_link(format!("/proc/{}/exe", app.pid))
            .expect("independent process oracle");
        assert_eq!(executable, program);
        adapter
            .close_app(app, false, &lease)
            .expect("close selected desktop id");
        match std::fs::read_to_string(format!("/proc/{}/stat", app.pid)) {
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
            Ok(stat) => assert!(
                stat.rsplit_once(") ")
                    .is_some_and(|(_, tail)| matches!(tail.chars().next(), Some('Z' | 'X'))),
                "close leaves no running process"
            ),
            Err(error) => panic!("process exit oracle: {error}"),
        }
    }
}
