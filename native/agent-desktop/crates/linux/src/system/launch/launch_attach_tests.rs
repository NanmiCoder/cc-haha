use super::*;

fn app(pid: u32, name: &str) -> Running {
    Running {
        executable: keys(&[name]),
        pid,
        instance: format!("boot:{pid}"),
        name: name.to_owned(),
    }
}

fn keys(items: &[&str]) -> Option<crate::system::process::executable_identity::ExecutableIdentity> {
    Some(
        crate::system::process::executable_identity::ExecutableIdentity {
            executable: std::path::PathBuf::from(format!("/apps/{}", items[0])),
            argv: Some(vec![format!("/apps/{}", items[0]).into()]),
        },
    )
}

#[test]
fn no_match_spawns() {
    let running = [app(1, "nautilus")];
    let decision = decide(&keys(&["gnome-calculator"]), &running, true, false);
    assert_eq!(decision, Decision::Spawn);
}

#[test]
fn one_match_without_arguments_attaches_and_spawns_nothing() {
    let owner = app(7, "gnome-text-editor");
    let decision = decide(
        &keys(&["gnome-text-editor"]),
        std::slice::from_ref(&owner),
        true,
        false,
    );
    assert_eq!(decision, Decision::Attach(owner));
}

#[test]
fn one_match_with_arguments_spawns_and_reports_the_owner() {
    let owner = app(7, "gnome-text-editor");
    let decision = decide(
        &keys(&["gnome-text-editor"]),
        std::slice::from_ref(&owner),
        true,
        true,
    );
    assert_eq!(decision, Decision::Forward);
}

#[test]
fn a_match_with_attach_off_refuses_naming_the_pid() {
    let owner = app(7, "gnome-calculator");
    let decision = decide(&keys(&["gnome-calculator"]), &[owner], false, false);
    assert_eq!(decision, Decision::Refuse(vec![7]));
}

#[test]
fn two_matches_are_ambiguous_and_two_with_attach_off_still_refuse() {
    let running = [app(7, "nautilus"), app(8, "nautilus")];
    let wanted = keys(&["nautilus"]);
    assert_eq!(
        decide(&wanted, &running, true, false),
        Decision::Ambiguous(vec![7, 8])
    );
    assert_eq!(
        decide(&wanted, &running, false, false),
        Decision::Refuse(vec![7, 8])
    );
}
