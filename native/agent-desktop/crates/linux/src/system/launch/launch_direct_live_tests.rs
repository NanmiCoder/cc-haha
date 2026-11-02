use super::*;
use crate::tree::live::live_launch::Launched;

#[test]
#[ignore = "runs owned GTK apps; use a private managed X11 or native Wayland session"]
fn direct_interpreter_identity_distinguishes_toolkits_and_refuses_only_exact_argv() {
    let runtime = std::env::var("AGENT_DESKTOP_PRIVATE_SESSION").unwrap();
    let script = format!("{runtime}/direct-identity.py");
    std::fs::write(
        &script,
        r#"
import gi,sys
gi.require_version('Gtk',sys.argv[1])
from gi.repository import Gtk,GLib
if sys.argv[1]=='3.0':
    w=Gtk.Window()
    w.show_all()
    Gtk.main()
else:
    Gtk.init()
    w=Gtk.Window()
    w.present()
    GLib.MainLoop().run()
"#,
    )
    .unwrap();
    let executable = format!("{runtime}/interpreter");
    std::fs::copy("/usr/bin/python3", &executable).unwrap();
    let mut owned = Owned(Vec::new());
    let mut other = Launched::new();
    let other_pid = other.spawn(&executable, &[&script, "3.0"]);
    wait_until("first toolkit registry", || registry_has(other_pid));
    let request = LaunchOptions {
        attach_if_running: false,
        ..options(&[&script, "4.0"])
    };
    let target = launch(&executable, &request).expect("different interpreter argv may launch");
    owned.keep(target.pid.get());
    assert_ne!(target.pid.get(), other_pid);
    for (pid, toolkit) in [(other_pid, "3.0"), (target.pid.get(), "4.0")] {
        let cmdline = std::fs::read(format!("/proc/{pid}/cmdline")).unwrap();
        assert_eq!(
            cmdline
                .split(|b| *b == 0)
                .filter(|word| !word.is_empty())
                .collect::<Vec<_>>(),
            [executable.as_bytes(), script.as_bytes(), toolkit.as_bytes()]
        );
        let oracle = Command::new("python3")
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
        if app.get_process_id()!=int(sys.argv[1]): continue
        for j in range(app.get_child_count()):
            if app.get_child_at_index(j).get_state_set().contains(Atspi.StateType.SHOWING):
                print('independent Atspi owner',sys.argv[1]);sys.exit(0)
    time.sleep(.1)
sys.exit(1)
"#,
                &pid.to_string(),
            ])
            .output()
            .unwrap();
        assert!(
            oracle.status.success(),
            "{}",
            String::from_utf8_lossy(&oracle.stderr)
        );
        print!("{}", String::from_utf8_lossy(&oracle.stdout));
    }
    let processes = || {
        let mut pids: Vec<u32> = std::fs::read_dir("/proc")
            .unwrap()
            .filter_map(Result::ok)
            .filter_map(|entry| entry.file_name().to_string_lossy().parse::<u32>().ok())
            .filter(|pid| {
                std::fs::read_link(format!("/proc/{pid}/exe"))
                    .ok()
                    .as_deref()
                    == Some(std::path::Path::new(&executable))
            })
            .collect();
        pids.sort_unstable();
        pids
    };
    let before_refusal = processes();
    let refusal = launch(&executable, &request).unwrap_err();
    assert_eq!(refusal.code, ErrorCode::ActionFailed);
    assert_eq!(
        refusal.disposition,
        agent_desktop_core::DeliverySemantics::not_delivered()
    );
    assert_eq!(
        processes(),
        before_refusal,
        "the refused exact invocation spawned no additional app"
    );
    let clean_exit = launch(&executable, &options(&["-c", "pass"]))
        .expect_err("a clean script exit must not adopt an unrelated interpreter owner");
    assert_eq!(clean_exit.code, ErrorCode::ActionFailed);
    assert_eq!(
        clean_exit.disposition,
        agent_desktop_core::DeliverySemantics::delivered_unverified()
    );
    assert_eq!(
        processes(),
        before_refusal,
        "the two independent GUI owners remain"
    );
    println!(
        "independent /proc argv and Atspi: GTK3 {other_pid} != GTK4 {}; exact repeated argv refuses before spawn",
        target.pid
    );
}
