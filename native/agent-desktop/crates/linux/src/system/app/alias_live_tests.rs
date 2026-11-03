use std::time::{Duration, Instant};

use agent_desktop_core::commands::close_app::{CloseAppArgs, execute};

use crate::LinuxAdapter;
use crate::system::focus::focus_window::lift_live_tests::{deadline, xid_of};
use crate::system::{SharedBus, app_inventory};
use crate::tree::live::live_launch::Launched;

#[test]
#[ignore = "closes owned Zenity windows; run inside scripts/private-session.sh --wm"]
fn ambiguous_exec_and_try_exec_names_cannot_close_another_app() {
    let runtime = std::env::var("AGENT_DESKTOP_PRIVATE_SESSION").expect("private session");
    let data = std::path::PathBuf::from(std::env::var("XDG_DATA_HOME").expect("private data"));
    let entries = data.join("applications");
    std::fs::create_dir_all(&entries).expect("desktop entries");
    let shared = format!("{runtime}/ad-alias-shared");
    let helper = format!("{runtime}/ad-alias-helper");
    let unique = format!("{runtime}/ad-alias-unique");
    for executable in [&shared, &helper, &unique] {
        std::fs::copy("/usr/bin/zenity", executable).expect("private executable");
    }
    for (id, name, exec, extra) in [
        ("ad-one", "AD Alias One", &shared, String::new()),
        ("ad-two", "AD Alias Two", &shared, String::new()),
        (
            "ad-client",
            "AD Alias Client",
            &unique,
            format!("TryExec={helper}\n"),
        ),
    ] {
        std::fs::write(
            entries.join(format!("{id}.desktop")),
            format!("[Desktop Entry]\nType=Application\nName={name}\nExec={exec} --info \"--text={} owner\"\n{extra}", if id == "ad-client" { "unique" } else { "alias" }),
        )
        .expect("entry");
    }
    let mut launched = Launched::new();
    let adapter = LinuxAdapter::new();
    for _ in 0..2 {
        for (program, query) in [(&shared, "AD Alias Two"), (&helper, "AD Alias Client")] {
            let pid = launched.spawn(program, &["--info", "--text=alias owner"]);
            let xid = xid_of(pid);
            wait_listed(pid);
            let error = execute(
                CloseAppArgs {
                    app: query.to_owned(),
                    force: false,
                },
                &adapter,
            )
            .expect_err("an unproven display name must not select the process");
            assert_eq!(error.code(), "APP_NOT_FOUND");
            assert!(std::path::Path::new(&format!("/proc/{pid}/exe")).exists());
            assert!(
                crate::system::focus::focus_window::lift_live_tests::xprop(&[
                    "-id",
                    &xid,
                    "_NET_WM_PID"
                ])
                .contains(&pid.to_string())
            );
            execute(
                CloseAppArgs {
                    app: program.rsplit('/').next().expect("basename").to_owned(),
                    force: false,
                },
                &adapter,
            )
            .expect("the explicit executable still closes its own process");
            let started = Instant::now();
            while std::path::Path::new(&format!("/proc/{pid}/exe")).exists() {
                assert!(
                    started.elapsed() < Duration::from_secs(5),
                    "process exit oracle"
                );
                std::thread::sleep(Duration::from_millis(20));
            }
        }
        let pid = launched.spawn(&unique, &["--info", "--text=unique owner"]);
        xid_of(pid);
        wait_listed(pid);
        execute(
            CloseAppArgs {
                app: "AD Alias Client".to_owned(),
                force: false,
            },
            &adapter,
        )
        .expect("a unique Exec name closes its own app");
        assert!(!std::path::Path::new(&format!("/proc/{pid}/exe")).exists());
    }
}

fn wait_listed(pid: u32) {
    let started = Instant::now();
    while !app_inventory(&SharedBus::default(), deadline(5_000))
        .is_ok_and(|inventory| inventory.apps.iter().any(|app| app.pid == pid))
    {
        assert!(
            started.elapsed() < Duration::from_secs(20),
            "registry readiness"
        );
        std::thread::sleep(Duration::from_millis(50));
    }
}
