use super::resolve;
use super::tests::fixture;
use crate::system::launch::launch_attach::{Decision, decide};
use crate::system::process::running_app::Running;
use crate::tree::live::test_support::copy_blocking_program;

fn owner(program: &str, args: &[&str]) -> Running {
    Running {
        executable: Some(
            crate::system::process::executable_identity::ExecutableIdentity {
                executable: std::fs::canonicalize(program).expect("program"),
                argv: Some(
                    std::iter::once(std::ffi::OsString::from(program))
                        .chain(args.iter().map(std::ffi::OsString::from))
                        .collect(),
                ),
            },
        ),
        pid: 1,
        instance: "fixture:1".into(),
        name: program.rsplit('/').next().unwrap().to_owned(),
    }
}

fn rejects_wrong_process(class: &str) {
    let fixture = fixture(&[], &[]);
    let bin = &fixture.search.path_dirs[0];
    let a = bin.join("a");
    let b = bin.join("b");
    std::fs::create_dir(&a).unwrap();
    std::fs::create_dir(&b).unwrap();
    let target = copy_blocking_program(&b, "editor");
    let other = copy_blocking_program(&a, "editor");
    let mut owner = owner(other.to_str().unwrap(), &["30"]);
    let id = match class {
        "comm" => {
            owner.name = "unrelated".into();
            target.to_str().unwrap().to_owned()
        }
        "alias" | "try-exec" => {
            owner.name = "sole-app".into();
            let extra = if class == "try-exec" {
                format!("TryExec={}\n", other.display())
            } else {
                String::new()
            };
            std::fs::write(
                fixture.search.data_dirs[0].join("sole-app.desktop"),
                format!(
                    "[Desktop Entry]\nType=Application\nName=Sole App\nExec={}\n{extra}",
                    target.display()
                ),
            )
            .unwrap();
            "sole-app".into()
        }
        "interpreter" | "direct-interpreter" => {
            owner = self::owner("/usr/bin/python3", &["-c", "import time; time.sleep(30)"]);
            std::fs::write(fixture.search.data_dirs[0].join("sole-app.desktop"), "[Desktop Entry]\nType=Application\nName=Sole App\nExec=/usr/bin/python3 /opt/other.py\nTryExec=/bin/sleep\n").unwrap();
            if class == "direct-interpreter" {
                "/usr/bin/python3".into()
            } else {
                "sole-app".into()
            }
        }
        _ => target.to_str().unwrap().to_owned(),
    };
    let index = crate::system::app::alias_cache::AliasCache::new().index(&fixture.search.data_dirs);
    let plan = resolve(&id, &[], &fixture.search, &index).expect("resolve");
    let actual = decide(&plan.identity, &[owner], true, false);
    assert_eq!(actual, Decision::Spawn, "wrong-process class {class}");
}

#[test]
fn launch_rejects_comm_identity_without_executable_proof() {
    rejects_wrong_process("comm");
}
#[test]
fn launch_rejects_sole_entry_alias_without_executable_proof() {
    rejects_wrong_process("alias");
}
#[test]
fn a_running_try_exec_helper_is_not_the_requested_desktop_app() {
    rejects_wrong_process("try-exec");
}
#[test]
fn launch_rejects_sole_interpreter_with_different_argv() {
    rejects_wrong_process("interpreter");
}
#[test]
fn direct_launch_never_attaches_to_another_interpreter_invocation() {
    rejects_wrong_process("direct-interpreter");
    let fixture = fixture(&[], &[]);
    let args = ["-c", "import time; time.sleep(30)"];
    let owner = owner("/usr/bin/python3", &args);
    let arguments = args.map(String::from);
    let index = crate::system::app::alias_cache::AliasCache::new().index(&fixture.search.data_dirs);
    let plan = resolve("/usr/bin/python3", &arguments, &fixture.search, &index).unwrap();
    let decision = decide(&plan.identity, std::slice::from_ref(&owner), true, true);
    let mut unknown = plan.identity.clone();
    unknown.as_mut().unwrap().argv = None;
    let missing_arguments = decide(&unknown, std::slice::from_ref(&owner), true, false);
    assert_eq!(decision, Decision::Forward);
    assert_eq!(missing_arguments, Decision::Spawn);
}
#[test]
fn launch_rejects_same_basename_at_another_absolute_path() {
    rejects_wrong_process("absolute");
}

#[test]
fn launch_rejects_a_different_interpreter_invocation_name() {
    let fixture = fixture(&[], &[]);
    let bin = &fixture.search.path_dirs[0];
    let requested = bin.join("bash");
    let other = bin.join("sh");
    for path in [&requested, &other] {
        std::os::unix::fs::symlink("/bin/bash", path).unwrap();
    }
    let args = ["-c", "while :; do :; done"];
    let mut owner = owner(other.to_str().unwrap(), &args);
    std::fs::write(
        fixture.search.data_dirs[0].join("shell-app.desktop"),
        format!(
            "[Desktop Entry]\nType=Application\nName=Shell App\nExec={} -c \"while :; do :; done\"\n",
            requested.display()
        ),
    )
    .unwrap();
    let index = crate::system::app::alias_cache::AliasCache::new().index(&fixture.search.data_dirs);
    let plan = resolve("shell-app", &[], &fixture.search, &index).unwrap();
    let wrong = decide(&plan.identity, std::slice::from_ref(&owner), true, false);
    let aliases = index.names_for(owner.executable.as_ref().unwrap());
    assert_eq!(wrong, Decision::Spawn);
    assert!(aliases.is_empty());
    owner.executable.as_mut().unwrap().argv.as_mut().unwrap()[0] = requested.into_os_string();
    let correct = decide(&plan.identity, std::slice::from_ref(&owner), true, false);
    let aliases = index.names_for(owner.executable.as_ref().unwrap());
    assert_eq!(correct, Decision::Attach(owner));
    assert_eq!(aliases, ["Shell App"]);
}
