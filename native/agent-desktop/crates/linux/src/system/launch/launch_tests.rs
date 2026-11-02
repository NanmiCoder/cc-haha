use std::collections::BTreeMap;
use std::path::PathBuf;
use std::process::Command;
use std::time::{Duration, Instant};

use super::*;
use crate::system::launch::launch_target::Plan;

fn options() -> LaunchOptions {
    LaunchOptions::default()
}

fn owner() -> Running {
    Running {
        executable: None,
        pid: 4_000_000,
        instance: "boot:9".to_owned(),
        name: "tool".to_owned(),
    }
}

fn window() -> WindowInfo {
    WindowInfo {
        id: "w-1".to_owned(),
        title: "Tool".to_owned(),
        app: "tool".to_owned(),
        pid: ProcessId::new(4_000_000),
        process_instance: Some("boot:9".to_owned()),
        bounds: None,
        state: Default::default(),
    }
}

fn plan_of(argv: &[&str]) -> Plan {
    Plan {
        argv: argv.iter().map(|word| (*word).to_owned()).collect(),
        cwd: None,
        identity: None,
    }
}

#[test]
fn an_expired_baseline_deadline_prevents_spawning() {
    let bus = SharedBus::default();
    let options = options();
    let lease = InteractionLease::guarded(Deadline::after(1_000).unwrap(), ()).unwrap();
    let launch = Launch {
        bus: &bus,
        id: "true",
        options: &options,
        lease: &lease,
        deadline: Deadline::after(0).unwrap(),
    };
    let error = launch
        .start(&plan_of(&["/bin/true"]), &None, &[])
        .expect_err("an expired launch must not start the process");
    assert_eq!(error.code, ErrorCode::Timeout);
    assert_eq!(error.disposition, DeliverySemantics::not_delivered());
}

fn kill(spawned: &Spawned) {
    let _ = Command::new("kill").arg(spawned.pid.to_string()).status();
}

#[test]
fn a_bad_argument_environment_or_directory_is_invalid_before_any_spawn() {
    let nul = LaunchOptions {
        args: vec!["a\0b".to_owned()],
        ..options()
    };
    let env = |key: &str, value: &str| LaunchOptions {
        env: BTreeMap::from([(key.to_owned(), value.to_owned())]),
        ..options()
    };
    let missing = LaunchOptions {
        cwd: Some(PathBuf::from("/nonexistent/dir")),
        ..options()
    };
    for bad in [nul, env("", "v"), env("A=B", "v"), env("A", "v\0"), missing] {
        let error = validate(&bad).expect_err("invalid");
        assert_eq!(error.code, ErrorCode::InvalidArgs);
        assert_eq!(error.disposition, DeliverySemantics::not_delivered());
    }
    assert!(validate(&env("FINE", "1")).is_ok());
}

#[test]
fn a_missing_program_is_app_not_found_and_the_error_holds_no_argument_or_environment_value() {
    let launch = LaunchOptions {
        env: BTreeMap::from([("MARKER_ENV".to_owned(), "MARKER_SECRET_ENV".to_owned())]),
        ..options()
    };
    let plan = plan_of(&["/nonexistent/program", "MARKER_SECRET_ARG"]);
    let error = spawn("tool", &plan, &launch).err().expect("not found");
    assert_eq!(error.code, ErrorCode::AppNotFound);
    assert_eq!(error.disposition, DeliverySemantics::not_delivered());
    let text = format!("{error:?}");
    assert!(!text.contains("MARKER"), "{text}");
    assert!(text.contains("tool"));
}

const REPORTER: &str = r#"report="$1"
stdin=$(readlink /proc/$$/fd/0)
stdout=$(readlink /proc/$$/fd/1)
stderr=$(readlink /proc/$$/fd/2)
group=$(cut -d' ' -f5 /proc/$$/stat)
printf '%s
' "$stdin" "$stdout" "$stderr" "$group" > "$report/facts"
env -0 > "$report/environ"
: > "$report/done""#;

struct Report {
    directory: PathBuf,
    spawned: Spawned,
}

impl Report {
    fn of(launch: &LaunchOptions) -> Self {
        static NEXT: std::sync::atomic::AtomicU32 = std::sync::atomic::AtomicU32::new(0);
        let directory = std::env::temp_dir().join(format!(
            "launch-report-{}-{}",
            std::process::id(),
            NEXT.fetch_add(1, std::sync::atomic::Ordering::Relaxed)
        ));
        std::fs::create_dir_all(&directory).expect("report directory");
        let directory_argument = directory.to_string_lossy().into_owned();
        let plan = plan_of(&["/bin/sh", "-c", REPORTER, "sh", &directory_argument]);
        let spawned = spawn("reporter", &plan, launch).expect("spawn");
        let deadline = Instant::now() + Duration::from_secs(30);
        while !directory.join("done").exists() && Instant::now() < deadline {
            std::thread::sleep(Duration::from_millis(10));
        }
        assert!(
            directory.join("done").exists(),
            "the reporter never finished"
        );
        Self { directory, spawned }
    }

    fn facts(&self) -> Vec<String> {
        std::fs::read_to_string(self.directory.join("facts"))
            .expect("facts")
            .lines()
            .map(str::to_owned)
            .collect()
    }

    fn environ(&self) -> Vec<u8> {
        std::fs::read(self.directory.join("environ")).expect("environ")
    }
}

impl Drop for Report {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.directory);
    }
}

#[test]
fn the_app_gets_the_null_device_its_own_group_and_the_caller_environment_plus_the_additions() {
    let launch = LaunchOptions {
        env: BTreeMap::from([("LAUNCH_TEST_ADDED".to_owned(), "yes".to_owned())]),
        ..options()
    };
    let report = Report::of(&launch);
    let facts = report.facts();
    assert_eq!(
        facts,
        [
            "/dev/null",
            "/dev/null",
            "/dev/null",
            &report.spawned.pid.to_string()
        ]
    );
    let environ = report.environ();
    let variables: Vec<&[u8]> = environ.split(|byte| *byte == 0).collect();
    assert!(variables.contains(&b"LAUNCH_TEST_ADDED=yes".as_slice()));
    let inherited = std::env::var("PATH").expect("PATH");
    assert!(variables.contains(&format!("PATH={inherited}").as_bytes()));
    for name in [
        "DISPLAY",
        "WAYLAND_DISPLAY",
        "DBUS_SESSION_BUS_ADDRESS",
        "XDG_RUNTIME_DIR",
    ] {
        if let Ok(value) = std::env::var(name) {
            let line = format!("{name}={value}");
            assert!(variables.contains(&line.as_bytes()), "{name}");
        }
    }
}

#[test]
fn a_spawned_child_is_reaped_once_its_guard_goes() {
    let report = Report::of(&options());
    let pid = report.spawned.pid;
    drop(report);
    let deadline = Instant::now() + Duration::from_secs(10);
    while std::path::Path::new(&format!("/proc/{pid}")).exists() && Instant::now() < deadline {
        std::thread::sleep(Duration::from_millis(10));
    }
    assert!(
        !std::path::Path::new(&format!("/proc/{pid}")).exists(),
        "the spawned child {pid} was reaped"
    );
}

#[test]
fn a_directory_of_the_entry_that_does_not_exist_is_not_used() {
    let mut plan = plan_of(&["/bin/sleep", "30"]);
    plan.cwd = Some(PathBuf::from("/nonexistent/entry/dir"));
    let spawned = spawn("sleep", &plan, &options()).expect("spawn");
    kill(&spawned);
}

#[test]
fn a_refused_focus_still_reports_the_launch_and_says_why() {
    let asked = LaunchOptions {
        activate: true,
        ..options()
    };
    let original = window();
    let result = conclude(&owner(), Some(original.clone()), &asked, true, |_| {
        Err(AdapterError::new(ErrorCode::ActionFailed, "no focus"))
    });
    let reported = result.window.expect("window");
    assert_eq!(reported.id, original.id);
    assert!(!reported.state.is_focused);
    assert!(result.suggestion.expect("note").contains("no focus"));
}

#[test]
fn a_successful_activation_reports_the_window_read_after_the_request() {
    let asked = LaunchOptions {
        activate: true,
        ..options()
    };
    let mut focused = window();
    focused.state.is_focused = true;
    let result = conclude(&owner(), Some(window()), &asked, true, |_| {
        Ok(Some(focused.clone()))
    });
    let reported = result.window.expect("window");
    assert_eq!(reported.id, focused.id);
    assert!(reported.state.is_focused);
}

#[test]
fn an_activation_with_no_window_read_after_it_keeps_the_window_it_had() {
    let asked = LaunchOptions {
        activate: true,
        ..options()
    };
    let original = window();
    let result = conclude(&owner(), Some(original.clone()), &asked, true, |_| Ok(None));
    let reported = result.window.expect("window");
    assert_eq!(reported.id, original.id);
    assert!(result.suggestion.is_none());
}

#[test]
fn a_reused_instance_says_the_environment_and_directory_were_dropped() {
    let with_env = LaunchOptions {
        env: BTreeMap::from([("A".to_owned(), "1".to_owned())]),
        ..options()
    };
    let reused = conclude(&owner(), None, &with_env, false, |_| Ok(None));
    assert!(reused.suggestion.expect("note").contains("not applied"));
    let created = conclude(&owner(), None, &with_env, true, |_| Ok(None));
    assert!(created.suggestion.is_none());
    let plain = conclude(&owner(), None, &options(), false, |_| Ok(None));
    assert!(plain.suggestion.is_none());
}

fn listed(id: &str) -> WindowInfo {
    WindowInfo {
        id: id.to_owned(),
        title: String::new(),
        app: "app".to_owned(),
        pid: 5.into(),
        process_instance: Some("i".to_owned()),
        bounds: None,
        state: agent_desktop_core::WindowState::default(),
    }
}

#[test]
fn a_window_that_was_open_before_a_forwarded_launch_is_never_its_window() {
    let known: HashSet<String> = HashSet::from(["w-old".to_owned()]);
    assert!(choose_window(vec![listed("w-old")], &known).is_none());
    let chosen =
        choose_window(vec![listed("w-old"), listed("w-new")], &known).expect("the new one");
    assert_eq!(chosen.id, "w-new");
}

#[test]
fn the_first_window_of_an_application_the_launch_started_is_its_window() {
    let chosen = choose_window(vec![listed("w-a"), listed("w-b")], &HashSet::new()).expect("one");
    assert_eq!(chosen.id, "w-a");
    assert!(choose_window(Vec::new(), &HashSet::new()).is_none());
}

#[test]
fn a_launched_process_carries_the_marker_that_proves_the_caller_started_it() {
    let report = Report::of(&options());
    assert!(crate::system::process::session_origin::has_launch_marker(
        &report.environ()
    ));
}

#[test]
fn the_window_read_after_an_activation_is_the_one_the_launch_chose() {
    let mut first = window();
    first.id = "w-first".to_owned();
    let mut chosen = window();
    chosen.id = "w-chosen".to_owned();
    chosen.state.is_focused = true;
    let reread = same_window(vec![first.clone(), chosen.clone()], "w-chosen").expect("chosen");
    assert_eq!(reread.id, "w-chosen");
    assert!(reread.state.is_focused);
    assert!(same_window(vec![first], "w-chosen").is_none());
}
