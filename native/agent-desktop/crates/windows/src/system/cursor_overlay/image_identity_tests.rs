use super::{image_stem, is_agent_desktop_image};
use std::path::{Path, PathBuf};

/// Paths are built by joining rather than written as literals, because this
/// crate also compiles on the lane whose separator is `/`, where a literal
/// `C:\...` is one long file name and the stem test would read as passing for
/// the wrong reason.
fn under_build_tree(file: &str) -> PathBuf {
    PathBuf::from("C:")
        .join("dev")
        .join("agent-desktop")
        .join("target")
        .join("release")
        .join(file)
}

#[test]
fn the_installed_binary_is_recognised_with_and_without_its_extension() {
    assert!(is_agent_desktop_image(&under_build_tree(
        "agent-desktop.exe"
    )));
    assert!(is_agent_desktop_image(&under_build_tree("agent-desktop")));
    assert!(is_agent_desktop_image(Path::new("agent-desktop.exe")));
}

/// `QueryFullProcessImageNameW` reports whatever case the file system holds,
/// which on a case-insensitive volume is not necessarily the case the build
/// produced.
#[test]
fn the_comparison_ignores_case_in_the_stem_and_the_extension() {
    assert!(is_agent_desktop_image(&under_build_tree(
        "AGENT-DESKTOP.EXE"
    )));
    assert!(is_agent_desktop_image(&under_build_tree(
        "Agent-Desktop.Exe"
    )));
}

#[test]
fn another_binary_is_rejected_even_from_our_own_build_tree() {
    assert!(!is_agent_desktop_image(&under_build_tree("notepad.exe")));
    assert!(!is_agent_desktop_image(&under_build_tree(
        "agent-desktop-ffi.exe"
    )));
    assert!(!is_agent_desktop_image(&under_build_tree("agent.exe")));
}

/// Only the final component is the image. A directory named after the project
/// is the ordinary shape of both the build tree and an install directory, and
/// matching on it would accept anything shipped alongside the binary.
#[test]
fn a_directory_named_after_the_project_does_not_make_its_contents_ours() {
    let directory = PathBuf::from("C:").join("dev").join("agent-desktop");

    assert!(!is_agent_desktop_image(&directory.join("some-tool.exe")));
}

#[test]
fn a_path_with_no_file_name_is_not_our_image_rather_than_a_panic() {
    assert!(!is_agent_desktop_image(Path::new("")));
    assert!(!is_agent_desktop_image(Path::new("..")));
    assert_eq!(image_stem(Path::new("")), None);
}

/// A leading-dot name has no extension to strip, so its whole name is the
/// stem. `.exe` alone is therefore not our image.
#[test]
fn a_bare_extension_is_not_our_image() {
    assert!(!is_agent_desktop_image(Path::new(".exe")));
    assert_eq!(image_stem(Path::new(".exe")), Some(".exe"));
}

#[test]
fn the_stem_reported_to_a_reader_is_the_file_name_without_its_extension() {
    assert_eq!(
        image_stem(&under_build_tree("notepad.exe")),
        Some("notepad")
    );
}
