use crate::cli_args::cursor_overlay_enable::CursorOverlayEnableArgs;
use clap::Parser;
use std::path::PathBuf;

#[derive(Parser)]
struct Harness {
    #[command(flatten)]
    enable: CursorOverlayEnableArgs,
}

fn parse(args: &[&str]) -> Result<Harness, clap::Error> {
    Harness::try_parse_from(std::iter::once("enable").chain(args.iter().copied()))
}

struct TempDir(PathBuf);

impl TempDir {
    fn new() -> Self {
        let unique = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let dir =
            std::env::temp_dir().join(format!("ad-cli-image-{}-{unique}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        Self(dir)
    }
}

impl Drop for TempDir {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}

#[cfg(unix)]
#[test]
fn image_and_motion_flags_are_validated_and_stored_together() {
    let dir = TempDir::new();
    let file = dir.0.join("cursor.png");
    std::fs::write(
        &file,
        b"\x89PNG\r\n\x1a\n\x00\x00\x00\x0dIHDR\x00\x00\x00\x20\x00\x00\x00\x20",
    )
    .unwrap();
    let cwd = std::env::current_dir().unwrap();
    let relative = pathdiff(&file, &cwd);
    let config = parse(&[
        "--image",
        relative.to_str().unwrap(),
        "--hotspot",
        "4,2.5",
        "--accent",
        "#FF0000",
        "--travel-ms",
        "100,400",
        "--bow",
        "2",
        "--overshoot",
        "0.1",
        "--tremor",
        "2",
        "--dwell-ms",
        "50",
        "--motion-seed",
        "42",
    ])
    .unwrap()
    .enable
    .to_core()
    .unwrap();
    let motion = config.motion();
    assert_eq!(motion.travel_ms(), (100, 400));
    assert_eq!(motion.bow(), 2.0);
    assert_eq!(motion.overshoot(), 0.1);
    assert_eq!(motion.tremor(), 2.0);
    assert_eq!(motion.dwell_ms(), 50);
    assert_eq!(motion.seed(), Some(42));
    let image = config.style().image().expect("image is set");
    assert_eq!(
        PathBuf::from(image.path()),
        std::fs::canonicalize(&file).unwrap()
    );
    assert_eq!((image.hotspot().x, image.hotspot().y), (4.0, 2.5));
    assert!(
        parse(&[])
            .unwrap()
            .enable
            .to_core()
            .unwrap()
            .style()
            .image()
            .is_none()
    );
}

#[cfg(unix)]
fn pathdiff(target: &std::path::Path, base: &std::path::Path) -> PathBuf {
    let ups = base.components().count() - 1;
    let mut relative = PathBuf::new();
    for _ in 0..ups {
        relative.push("..");
    }
    relative.join(target.strip_prefix("/").unwrap())
}

#[test]
fn hotspot_without_image_and_fill_with_image_are_parse_errors() {
    for args in [
        &["--hotspot", "1,1"][..],
        &["--image", "/tmp/c.png", "--fill", "#000000"][..],
        &["--image", "/tmp/c.png", "--rim", "#000000"][..],
        &["--image", "/tmp/c.png", "--hotspot", "1"][..],
        &["--pointer-hotspot", "1,1"][..],
    ] {
        let error = parse(args).err().expect("parse error");
        assert_eq!(error.exit_code(), 2, "{args:?}");
    }
}

#[test]
fn unreadable_or_mismatched_images_are_invalid_args() {
    let dir = TempDir::new();
    let missing = dir.0.join("missing.png");
    let fake = dir.0.join("fake.pdf");
    std::fs::write(&fake, b"\x89PNG\r\n\x1a\n").unwrap();
    let svg = dir.0.join("cursor.svg");
    std::fs::write(&svg, b"<svg/>").unwrap();
    for path in [missing, fake, svg] {
        let error = parse(&["--image", path.to_str().unwrap()])
            .unwrap()
            .enable
            .to_core()
            .expect_err("invalid image");
        assert_eq!(error.code(), "INVALID_ARGS", "{}", path.display());
    }
}

#[test]
fn a_pointer_image_is_verified_and_stored_beside_the_arrow() {
    let dir = TempDir::new();
    let hand = dir.0.join("hand.png");
    std::fs::write(
        &hand,
        b"\x89PNG\r\n\x1a\n\x00\x00\x00\x0dIHDR\x00\x00\x00\x20\x00\x00\x00\x20",
    )
    .unwrap();
    let config = parse(&[
        "--pointer-image",
        hand.to_str().unwrap(),
        "--pointer-hotspot",
        "7.5,0",
        "--fill",
        "#000000",
    ])
    .unwrap()
    .enable
    .to_core()
    .unwrap();
    let pointer = config.style().pointer_image().expect("pointer image");
    assert_eq!(
        PathBuf::from(pointer.path()),
        std::fs::canonicalize(&hand).unwrap()
    );
    assert_eq!((pointer.hotspot().x, pointer.hotspot().y), (7.5, 0.0));
    assert!(config.style().image().is_none(), "the arrow stays built in");
    let missing = dir.0.join("missing.png");
    let error = parse(&["--pointer-image", missing.to_str().unwrap()])
        .unwrap()
        .enable
        .to_core()
        .expect_err("missing pointer image");
    assert_eq!(error.code(), "INVALID_ARGS");
}
