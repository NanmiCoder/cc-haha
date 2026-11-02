use super::*;
use crate::system::process::process_facts::ProcessFacts;

fn facts(comm: &str, exe: Option<&str>) -> ProcessFacts {
    ProcessFacts {
        executable: None,
        comm: comm.to_owned(),
        exe_basename: exe.map(str::to_owned),
        instance: "boot:1".to_owned(),
    }
}

#[test]
fn the_name_is_the_executable_basename_whatever_the_root_would_say() {
    let process = facts("org.gnome.Nauti", Some("org.gnome.Nautilus"));
    assert_eq!(app_name(&process), "org.gnome.Nautilus");
}

#[test]
fn the_name_prefers_the_executable_over_the_cut_comm() {
    let process = facts("gnome-terminal-", Some("gnome-terminal-server"));
    assert_eq!(app_name(&process), "gnome-terminal-server");
}

#[test]
fn a_missing_or_blank_executable_falls_back_to_comm() {
    assert_eq!(app_name(&facts("python", None)), "python");
    assert_eq!(app_name(&facts("code", Some("  "))), "code");
}

#[test]
fn an_executable_deleted_while_it_runs_keeps_its_name() {
    let replaced = facts("calc", Some("gnome-calculator (deleted)"));
    assert_eq!(app_name(&replaced), "gnome-calculator");
    assert_eq!(app_name(&facts("x", Some(" (deleted)"))), "x");
}

fn aliased(query: &str, process: &ProcessFacts, aliases: &[&str]) -> bool {
    let aliases: Vec<String> = aliases.iter().map(|alias| (*alias).to_owned()).collect();
    name_matches(query, &app_name(process), &aliases)
}

#[test]
fn an_alias_matches_exactly_ignoring_case_and_never_renames_the_app() {
    let files = facts("nautilus", Some("nautilus"));
    assert!(aliased("Files", &files, &["Files"]));
    assert!(aliased("files", &files, &["Files"]));
    assert!(aliased("nautilus", &files, &["Files"]));
    assert!(!aliased("Files", &files, &[]));
    assert!(!aliased("File", &files, &["Files"]));
    assert!(!aliased("Files Helper", &files, &["Files"]));
    assert_eq!(app_name(&files), "nautilus");
}
