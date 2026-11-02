use crate::adapter::WindowsAdapter;
use crate::input::clipboard::set_content;
use crate::system::capture::capture_test_support::{
    HomeIsolation, install_windows_private_file, sample_png, with_restored_clipboard,
};
use crate::system::fixture::test_time::deadline;
use crate::system::private_file::WindowsPrivateFile;
use crate::tree::fixture::bootstrap;
use agent_desktop_core::commands::clipboard_get::{self, ClipboardGetArgs};
use agent_desktop_core::commands::screenshot::{self, ScreenshotArgs};
use agent_desktop_core::{
    ClipboardContent, ClipboardFormat, CommandContext, ImageBuffer, ImageFormat, PrivateFileOps,
    parse_png_dimensions,
};
use std::path::{Path, PathBuf};

fn create_junction(link: &Path, target: &Path) {
    let status = std::process::Command::new("cmd")
        .arg("/c")
        .arg("mklink")
        .arg("/J")
        .arg(link)
        .arg(target)
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .status()
        .expect("mklink /J must spawn");
    assert!(status.success(), "junction creation must succeed");
}

#[test]
fn clipboard_image_default_path_travels_private_seam_reparse_and_owner() {
    with_restored_clipboard(|| {
        install_windows_private_file();
        let adapter = WindowsAdapter::new();
        let home = HomeIsolation::enter("agent-desktop-routing-home");
        let agent = home.path().join(".agent-desktop");
        let elsewhere = home.path().join("elsewhere");
        std::fs::create_dir_all(&elsewhere).expect("elsewhere");
        std::fs::create_dir_all(&agent).expect("agent-desktop");
        let tmp_junction = agent.join("tmp");
        create_junction(&tmp_junction, &elsewhere);

        let png = sample_png();
        let (width, height) = parse_png_dimensions(&png).expect("dims");
        set_content(
            &ClipboardContent::Image(ImageBuffer {
                data: png,
                format: ImageFormat::Png,
                width,
                height,
                scale_factor: 1.0,
            }),
            deadline(10_000),
        )
        .expect("seed");

        let refused = clipboard_get::execute(
            ClipboardGetArgs {
                format: Some(ClipboardFormat::Image),
                out: None,
            },
            &adapter,
            &CommandContext::default(),
        )
        .expect_err("reparse tmp must refuse private write");
        assert!(
            elsewhere
                .read_dir()
                .map(|entries| entries.count() == 0)
                .unwrap_or(true),
            "private refusal must leave the junction target empty"
        );
        let _ = refused;

        std::fs::remove_dir(&tmp_junction).expect("remove junction");
        std::fs::create_dir_all(&tmp_junction).expect("real tmp");
        let image = clipboard_get::execute(
            ClipboardGetArgs {
                format: Some(ClipboardFormat::Image),
                out: None,
            },
            &adapter,
            &CommandContext::default(),
        )
        .expect("reparse-free private write");
        let written = PathBuf::from(image["path"].as_str().expect("path"));
        assert!(written.starts_with(&tmp_junction));
        WindowsPrivateFile::new()
            .read_private_bounded(&written, 1024 * 1024)
            .expect("TokenOwner validation accepts the private artifact");
        let _ = std::fs::remove_file(&written);
    });
}

#[test]
fn screenshot_user_path_bypasses_private_policy_that_refuses_reparse() {
    bootstrap();
    install_windows_private_file();
    let adapter = WindowsAdapter::new();
    let root =
        std::env::temp_dir().join(format!("agent-desktop-user-bypass-{}", std::process::id()));
    let elsewhere = root.join("elsewhere");
    let junction = root.join("redirect");
    std::fs::create_dir_all(&elsewhere).expect("elsewhere");
    std::fs::create_dir_all(&root).expect("root");
    create_junction(&junction, &elsewhere);
    let user_path = junction.join("shot.png");

    let refused = WindowsPrivateFile::new().write_atomic(&user_path, b"private");
    assert!(
        refused.is_err(),
        "private policy must refuse the reparse destination"
    );
    assert!(!elsewhere.join("shot.png").exists());

    let response = screenshot::execute(
        ScreenshotArgs {
            app: None,
            window_id: None,
            screen: None,
            output_path: Some(user_path.clone()),
        },
        &adapter,
    )
    .expect("user-named PATH must bypass the private seam");
    assert_eq!(response["path"], user_path.to_string_lossy().as_ref());
    assert!(
        elsewhere.join("shot.png").is_file(),
        "user write must land through the junction"
    );

    let _ = std::fs::remove_file(elsewhere.join("shot.png"));
    let _ = std::fs::remove_dir(&junction);
    let _ = std::fs::remove_dir_all(&root);
}
