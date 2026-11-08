use super::*;
use crate::system::launch::choose_window;
use crate::system::process::process_facts::ProcessFacts;
use crate::system::process::toolkit_id::ToolkitId;
use crate::system::registry::app_outcome::AppOutcome;
use crate::system::registry::registry_app::assemble;
use crate::system::signal::signal_inventory::pass_over;
use crate::system::x11::X11State;
use crate::tree::AtspiElement;

#[test]
fn residents_require_the_same_canonical_executable_but_not_the_same_arguments() {
    use crate::system::process::executable_identity::ExecutableIdentity;
    let requested = ExecutableIdentity {
        executable: "/usr/bin/tool".into(),
        argv: Some(vec!["tool".into()]),
    };
    let mut owner = Running {
        executable: Some(ExecutableIdentity {
            argv: Some(vec!["tool".into(), "--daemon".into()]),
            ..requested.clone()
        }),
        pid: 7,
        instance: "boot:7".to_owned(),
        name: "tool".to_owned(),
    };
    assert!(same_executable(Some(&requested), &owner));
    assert!(!requested.matches(owner.executable.as_ref().unwrap()));
    owner.executable.as_mut().unwrap().argv = None;
    assert!(same_executable(Some(&requested), &owner));
    owner.executable.as_mut().unwrap().executable = "/other/tool".into();
    assert!(!same_executable(Some(&requested), &owner));
    assert!(!same_executable(None, &owner));
    owner.executable = None;
    assert!(!same_executable(Some(&requested), &owner));
    assert!(!same_executable(None, &owner));
}

#[test]
fn an_old_frame_omitted_by_an_incomplete_baseline_cannot_be_a_launch_window() {
    let owner = Running {
        executable: None,
        pid: 5,
        instance: "boot:9".to_owned(),
        name: "tool".to_owned(),
    };
    let registry = Registry {
        apps: vec![assemble(
            AtspiElement::new(":1.5", "/root", owner.pid),
            ProcessFacts {
                executable: None,
                comm: "tool".to_owned(),
                exe_basename: Some("tool".to_owned()),
                instance: owner.instance.clone(),
            },
            Some(Some(owner.name.clone())),
            ToolkitId::default(),
        )],
        skipped: Vec::new(),
    };
    let mut pass = pass_over(
        Vec::new(),
        vec![AppOutcome {
            app: 0,
            read: RootRead::TimedOut,
        }],
        Vec::new(),
        &X11State::Unavailable,
    );
    let old = agent_desktop_core::WindowInfo {
        id: "w-old".to_owned(),
        title: "old".to_owned(),
        app: owner.name.clone(),
        pid: owner.pid.into(),
        process_instance: Some(owner.instance.clone()),
        bounds: None,
        state: Default::default(),
    };
    let selected =
        ids_of(&registry, &pass, &owner).map(|known| choose_window(vec![old.clone()], &known));
    assert_eq!(
        selected
            .expect_err("partial baseline cannot prove a handoff window")
            .code,
        agent_desktop_core::ErrorCode::Timeout
    );

    pass.outcomes[0].read = RootRead::Read;
    assert!(
        ids_of(&registry, &pass, &owner)
            .expect("complete empty baseline")
            .is_empty()
    );
    pass.outcomes.clear();
    assert!(
        ids_of(&registry, &pass, &owner).is_err(),
        "an unread owner is incomplete"
    );
    pass.recovered.push(0);
    pass.windows
        .push(crate::system::registry::listed_window::ListedWindow {
            app: 0,
            info: agent_desktop_core::WindowInfo {
                id: "w-1.5-stopped-x42".to_owned(),
                state: agent_desktop_core::WindowState {
                    accessible: false,
                    ..Default::default()
                },
                ..old
            },
            active: false,
            modal: false,
            dialog: false,
            frame: crate::system::x11::FrameFacts {
                size_identity: false,
                pid: owner.pid,
                title: "old".to_owned(),
                extents: None,
                global_position: false,
            },
            sheet: false,
            unshown: false,
        });
    assert!(
        ids_of(&registry, &pass, &owner).is_err(),
        "X11 recovery cannot prove the old windows' AT-SPI identities"
    );
}
