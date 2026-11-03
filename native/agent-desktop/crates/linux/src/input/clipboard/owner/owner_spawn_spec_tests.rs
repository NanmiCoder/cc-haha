use std::ffi::OsStr;
use std::path::Path;
use std::process::Command;

use super::*;

fn none(_: &str) -> Option<String> {
    None
}

fn command_with(parent: &dyn Fn(&str) -> Option<String>) -> Command {
    let nonce = crate::input::clipboard::owner::owner_spawn::new_nonce();
    build_command(
        Path::new("/opt/x/agent-desktop-linux-clipboard-owner"),
        ":77",
        &nonce,
        9,
        parent,
    )
}

fn env_value<'a>(command: &'a Command, name: &str) -> Option<&'a OsStr> {
    command
        .get_envs()
        .find_map(|(key, value)| (key == OsStr::new(name)).then_some(value).flatten())
}

#[test]
fn an_unrelated_parent_variable_is_dropped_and_an_unset_one_stays_unset() {
    let parent = |name: &str| match name {
        "SSH_AUTH_SOCK" | "PATH" | "AGENT_DESKTOP_INTERACTION_LEASE_FD" => Some("x".to_owned()),
        "HOME" => Some("/home/u".to_owned()),
        _ => None,
    };
    let command = command_with(&parent);
    assert_eq!(env_value(&command, "HOME"), Some(OsStr::new("/home/u")));
    for name in [
        "SSH_AUTH_SOCK",
        "PATH",
        "AGENT_DESKTOP_INTERACTION_LEASE_FD",
        "XAUTHORITY",
    ] {
        assert_eq!(env_value(&command, name), None, "{name}");
    }
}

#[test]
fn the_display_is_the_one_the_setter_resolved_and_not_the_parents() {
    let parent = |name: &str| (name == "DISPLAY").then(|| ":0".to_owned());
    let command = command_with(&parent);
    assert_eq!(env_value(&command, "DISPLAY"), Some(OsStr::new(":77")));
    assert_eq!(env_value(&command, DISPLAY_ENV), Some(OsStr::new(":77")));
}

#[test]
fn a_foreign_host_with_no_lease_variable_changes_nothing() {
    assert!(!protect_lease_descriptor(&none));
}

#[test]
fn a_number_that_is_not_an_open_descriptor_or_is_a_standard_stream_is_left_alone() {
    for value in ["1", "2", "notanumber", "99999", "-4"] {
        let parent = |name: &str| (name == INTERACTION_LEASE_FD_ENV).then(|| value.to_owned());
        assert!(!protect_lease_descriptor(&parent), "{value}");
    }
}
