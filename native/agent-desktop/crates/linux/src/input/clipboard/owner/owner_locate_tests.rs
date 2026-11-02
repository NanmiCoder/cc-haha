use std::fs;
use std::os::unix::fs::{PermissionsExt, symlink};
use std::path::{Path, PathBuf};

use agent_desktop_core::{DeliverySemantics, ErrorCode};

use super::*;

fn maps_line(start: usize, end: usize, path: &Path) -> String {
    format!(
        "{start:x}-{end:x} r-xp 00000000 08:01 1234 {}\n",
        path.display()
    )
}

fn scratch(name: &str) -> PathBuf {
    use std::os::unix::fs::DirBuilderExt;

    let name = agent_desktop_core::temporary_file_name(std::ffi::OsStr::new(name));
    let dir = std::env::temp_dir().join(name);
    std::fs::DirBuilder::new()
        .mode(0o700)
        .create(&dir)
        .expect("exclusive private temporary directory");
    dir
}

fn install(dir: &Path, mode: u32) -> PathBuf {
    let helper = dir.join(HELPER_NAME);
    fs::write(&helper, "#!/bin/sh\n").expect("a helper file");
    fs::set_permissions(&helper, fs::Permissions::from_mode(mode)).expect("a mode");
    helper
}

fn image_in(dir: &Path, name: &str) -> PathBuf {
    let image = dir.join(name);
    fs::write(&image, "image").expect("an image file");
    image
}

#[test]
fn the_helper_sits_beside_a_library_image_found_in_the_maps() {
    let dir = scratch("library");
    let image = image_in(&dir, "libagent_desktop_ffi.so");
    let helper = install(&dir, 0o755);
    let maps = format!(
        "{}{}",
        maps_line(0x1000, 0x2000, Path::new("/usr/lib/libc.so.6")),
        maps_line(0x7000, 0x9000, &image)
    );
    let found = locate_in(&maps, 0x7abc).expect("the helper is located");
    assert_eq!(found, fs::canonicalize(helper).expect("canonical"));
}

#[test]
fn an_address_outside_every_mapping_finds_no_image() {
    let maps = maps_line(0x1000, 0x2000, Path::new("/usr/lib/libc.so.6"));
    assert_eq!(image_from_maps(&maps, 0x2000), None);
    assert_eq!(
        image_from_maps(&maps, 0x1fff),
        Some(PathBuf::from("/usr/lib/libc.so.6"))
    );
}

#[test]
fn a_deleted_image_suffix_is_dropped_and_anonymous_mappings_are_skipped() {
    let maps =
        "1000-2000 rw-p 00000000 00:00 0 \n3000-4000 r-xp 0 08:01 9 /opt/x/lib.so (deleted)\n";
    assert_eq!(image_from_maps(maps, 0x1500), None);
    assert_eq!(
        image_from_maps(maps, 0x3500),
        Some(PathBuf::from("/opt/x/lib.so"))
    );
}

fn refused_by(dir: &Path, image: &Path) -> agent_desktop_core::AdapterError {
    let maps = maps_line(0x1000, 0x2000, image);
    let error = locate_in(&maps, 0x1000).expect_err("the helper is refused");
    assert_eq!(error.code, ErrorCode::PlatformNotSupported, "{dir:?}");
    assert_eq!(error.disposition, DeliverySemantics::not_delivered());
    assert!(error.message.contains(HELPER_NAME), "{}", error.message);
    error
}

#[test]
fn a_missing_helper_is_refused_by_name() {
    let dir = scratch("missing");
    let image = image_in(&dir, "agent-desktop");
    refused_by(&dir, &image);
}

#[test]
fn a_directory_in_place_of_the_helper_is_refused() {
    let dir = scratch("directory");
    let image = image_in(&dir, "agent-desktop");
    fs::create_dir(dir.join(HELPER_NAME)).expect("a directory");
    refused_by(&dir, &image);
}

#[test]
fn a_symlink_out_of_the_directory_is_refused() {
    let dir = scratch("symlink");
    let elsewhere = scratch("symlink-target");
    let real = install(&elsewhere, 0o755);
    let image = image_in(&dir, "agent-desktop");
    symlink(real, dir.join(HELPER_NAME)).expect("a symlink");
    refused_by(&dir, &image);
}

#[test]
fn a_helper_that_is_not_executable_is_refused() {
    let dir = scratch("plain");
    let image = image_in(&dir, "agent-desktop");
    install(&dir, 0o644);
    let error = refused_by(&dir, &image);
    assert!(
        error.message.contains("not executable"),
        "{}",
        error.message
    );
}

#[test]
fn a_helper_writable_by_others_is_refused_whatever_the_group() {
    for mode in [0o757, 0o777, 0o702, 0o1757] {
        let dir = scratch(&format!("others-{mode:o}"));
        let helper = install(&dir, mode);
        let error = check_helper(&helper).expect_err("refused");
        assert!(error.message.contains("by others"), "{}", error.message);
    }
}

#[test]
fn a_group_writable_helper_in_a_shared_group_is_refused() {
    let dir = scratch("shared-group");
    let helper = install(&dir, 0o775);
    let error = check_helper(&helper).expect_err("refused");
    assert!(error.message.contains("by a group"), "{}", error.message);
    assert_eq!(error.code, ErrorCode::PlatformNotSupported);
    assert_eq!(error.disposition, DeliverySemantics::not_delivered());
}

fn directory_with(name: &str, mode: u32) -> PathBuf {
    let dir = scratch(name);
    fs::set_permissions(&dir, fs::Permissions::from_mode(mode)).expect("a directory mode");
    dir
}

#[test]
fn a_directory_writable_by_others_is_refused() {
    for mode in [0o777, 0o757, 0o707] {
        let dir = directory_with(&format!("dir-others-{mode:o}"), mode);
        let helper = install(&dir, 0o755);
        let error = check_helper(&helper).expect_err("refused");
        assert!(
            error.message.contains("The directory") && error.message.contains("by others"),
            "{}",
            error.message
        );
    }
}

#[test]
fn a_sticky_directory_writable_by_others_is_accepted() {
    let dir = directory_with("dir-sticky", 0o1707);
    let helper = install(&dir, 0o755);
    check_helper(&helper).expect("accepted");
}

#[test]
fn a_sticky_bit_does_not_excuse_a_group_that_is_shared() {
    let dir = directory_with("dir-sticky-group", 0o1770);
    let helper = install(&dir, 0o755);
    let error = check_helper(&helper).expect_err("refused");
    assert!(error.message.contains("The directory"), "{}", error.message);
}

#[test]
fn a_group_writable_directory_is_refused() {
    let dir = directory_with("dir-group", 0o775);
    let helper = install(&dir, 0o755);
    let error = check_helper(&helper).expect_err("refused");
    assert!(
        error.message.contains("The directory") && error.message.contains("by a group"),
        "{}",
        error.message
    );
}

#[test]
fn locating_refuses_group_write_on_the_helper_or_its_directory() {
    for directory in [false, true] {
        let dir = scratch(&format!("reject-group-{directory}"));
        let image = image_in(&dir, "agent-desktop");
        let helper = install(&dir, 0o755);
        let target = if directory { &dir } else { &helper };
        fs::set_permissions(target, fs::Permissions::from_mode(0o775)).expect("group write");
        let error = locate_in(&maps_line(0x1000, 0x2000, &image), 0x1000)
            .expect_err("group-writable installation is refused");
        assert_eq!(error.code, ErrorCode::PlatformNotSupported);
        assert_eq!(error.disposition, DeliverySemantics::not_delivered());
        assert!(error.message.contains("group"), "{}", error.message);
    }
}

#[test]
fn a_bundled_architecture_helper_is_validated_when_the_plain_helper_is_absent() {
    for mode in [0o755, 0o775] {
        let dir = scratch("bundled-helper");
        let image = image_in(&dir, "agent-desktop-linux");
        let helper = install(&dir, mode);
        let arch = if cfg!(target_arch = "aarch64") {
            "arm64"
        } else {
            "x64"
        };
        let bundled = dir.join(format!("{HELPER_NAME}-linux-{arch}"));
        fs::rename(helper, &bundled).expect("bundled helper");
        let result = locate_in(&maps_line(0x1000, 0x2000, &image), 0x1000);
        if mode == 0o755 {
            assert_eq!(result.expect("bundled helper"), bundled);
        } else {
            assert!(
                result
                    .expect_err("group write is refused")
                    .message
                    .contains("group")
            );
        }
    }
}
