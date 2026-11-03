use std::path::PathBuf;
use std::process::Command;

fn main() {
    println!("cargo:rerun-if-changed=src/system/launch_bridge.m");
    println!("cargo:rerun-if-changed=src/system/appkit_bridge.m");
    println!("cargo:rerun-if-changed=src/system/screen_bridge.m");
    println!("cargo:rerun-if-changed=src/system/cursor_overlay/cursor_overlay_bridge.m");
    println!("cargo:rerun-if-changed=src/system/cursor_overlay/cursor_overlay_chrome_bridge.m");
    println!("cargo:rerun-if-changed=src/system/cursor_overlay/cursor_overlay_chrome.h");
    println!("cargo:rerun-if-changed=src/system/cursor_overlay/cursor_overlay_display_bridge.m");
    println!("cargo:rerun-if-changed=src/system/cursor_overlay/cursor_overlay_image_bridge.m");
    println!("cargo:rerun-if-changed=src/system/permissions/permission_guide_bridge.m");
    println!("cargo:rerun-if-env-changed=TARGET");
    println!("cargo:rerun-if-env-changed=MACOSX_DEPLOYMENT_TARGET");
    if std::env::var("CARGO_CFG_TARGET_OS").as_deref() != Ok("macos") {
        return;
    }
    let target = required_target();
    let deployment = deployment_target();
    let version = std::env::var("CARGO_PKG_VERSION").unwrap_or_else(|_| "unknown".into());
    println!("cargo:rustc-env=AGENT_DESKTOP_MACOS_HELPER_BUILD_ID={version}:{target}:{deployment}");
    let Some(out_dir) = std::env::var_os("OUT_DIR").map(PathBuf::from) else {
        eprintln!("OUT_DIR is required");
        std::process::exit(1);
    };
    let object = out_dir.join("launch_bridge.o");
    let appkit_object = out_dir.join("appkit_bridge.o");
    let screen_object = out_dir.join("screen_bridge.o");
    let cursor_overlay_object = out_dir.join("cursor_overlay_bridge.o");
    let cursor_overlay_chrome_object = out_dir.join("cursor_overlay_chrome_bridge.o");
    let cursor_overlay_display_object = out_dir.join("cursor_overlay_display_bridge.o");
    let cursor_overlay_image_object = out_dir.join("cursor_overlay_image_bridge.o");
    let permission_guide_object = out_dir.join("permission_guide_bridge.o");
    let archive = out_dir.join("libagent_desktop_launch_bridge.a");
    run(
        Command::new("xcrun")
            .args(["--sdk", "macosx", "clang"])
            .args(["-fobjc-arc", "-target", &target])
            .arg(format!("-mmacosx-version-min={deployment}"))
            .args([
                "-Wall",
                "-Wextra",
                "-Werror",
                "-c",
                "src/system/cursor_overlay/cursor_overlay_display_bridge.m",
                "-o",
            ])
            .arg(&cursor_overlay_display_object),
        "compile Objective-C cursor overlay display bridge",
    );
    run(
        Command::new("xcrun")
            .args(["--sdk", "macosx", "clang"])
            .args(["-fobjc-arc", "-target", &target])
            .arg(format!("-mmacosx-version-min={deployment}"))
            .args([
                "-Wall",
                "-Wextra",
                "-Werror",
                "-c",
                "src/system/cursor_overlay/cursor_overlay_bridge.m",
                "-o",
            ])
            .arg(&cursor_overlay_object),
        "compile Objective-C cursor overlay bridge",
    );
    run(
        Command::new("xcrun")
            .args(["--sdk", "macosx", "clang"])
            .args(["-fobjc-arc", "-target", &target])
            .arg(format!("-mmacosx-version-min={deployment}"))
            .args([
                "-Wall",
                "-Wextra",
                "-Werror",
                "-c",
                "src/system/cursor_overlay/cursor_overlay_chrome_bridge.m",
                "-o",
            ])
            .arg(&cursor_overlay_chrome_object),
        "compile Objective-C cursor overlay chrome bridge",
    );
    run(
        Command::new("xcrun")
            .args(["--sdk", "macosx", "clang"])
            .args(["-fobjc-arc", "-target", &target])
            .arg(format!("-mmacosx-version-min={deployment}"))
            .args([
                "-Wall",
                "-Wextra",
                "-Werror",
                "-c",
                "src/system/cursor_overlay/cursor_overlay_image_bridge.m",
                "-o",
            ])
            .arg(&cursor_overlay_image_object),
        "compile Objective-C cursor overlay image bridge",
    );
    run(
        Command::new("xcrun")
            .args(["--sdk", "macosx", "clang"])
            .args(["-fobjc-arc", "-fblocks", "-target", &target])
            .arg(format!("-mmacosx-version-min={deployment}"))
            .args([
                "-Wall",
                "-Wextra",
                "-Werror",
                "-c",
                "src/system/appkit_bridge.m",
                "-o",
            ])
            .arg(&appkit_object),
        "compile Objective-C AppKit bridge",
    );
    run(
        Command::new("xcrun")
            .args(["--sdk", "macosx", "clang"])
            .args(["-fobjc-arc", "-fblocks", "-target", &target])
            .arg(format!("-mmacosx-version-min={deployment}"))
            .args([
                "-Wall",
                "-Wextra",
                "-Werror",
                "-c",
                "src/system/launch_bridge.m",
                "-o",
            ])
            .arg(&object),
        "compile Objective-C launch bridge",
    );
    run(
        Command::new("xcrun")
            .args(["--sdk", "macosx", "clang"])
            .args(["-fobjc-arc", "-target", &target])
            .arg(format!("-mmacosx-version-min={deployment}"))
            .args([
                "-Wall",
                "-Wextra",
                "-Werror",
                "-c",
                "src/system/screen_bridge.m",
                "-o",
            ])
            .arg(&screen_object),
        "compile Objective-C screen bridge",
    );
    run(
        Command::new("xcrun")
            .args(["--sdk", "macosx", "clang"])
            .args(["-fobjc-arc", "-fblocks", "-target", &target])
            .arg(format!("-mmacosx-version-min={deployment}"))
            .args([
                "-Wall",
                "-Wextra",
                "-Werror",
                "-c",
                "src/system/permissions/permission_guide_bridge.m",
                "-o",
            ])
            .arg(&permission_guide_object),
        "compile Objective-C permission guide bridge",
    );
    run(
        Command::new("xcrun")
            .args(["--sdk", "macosx", "ar", "rcs"])
            .arg(&archive)
            .arg(&object)
            .arg(&appkit_object)
            .arg(&screen_object)
            .arg(&cursor_overlay_object)
            .arg(&cursor_overlay_display_object)
            .arg(&cursor_overlay_chrome_object)
            .arg(&cursor_overlay_image_object)
            .arg(&permission_guide_object),
        "archive Objective-C launch bridge",
    );
    println!("cargo:rustc-link-search=native={}", out_dir.display());
    println!("cargo:rustc-link-lib=static=agent_desktop_launch_bridge");
    println!("cargo:rustc-link-lib=framework=AppKit");
    println!("cargo:rustc-link-lib=framework=QuartzCore");
}

fn required_target() -> String {
    match std::env::var("TARGET") {
        Ok(target)
            if matches!(
                target.as_str(),
                "aarch64-apple-darwin" | "x86_64-apple-darwin"
            ) =>
        {
            target
        }
        Ok(target) => {
            eprintln!("unsupported macOS launch bridge target: {target}");
            std::process::exit(1);
        }
        Err(error) => {
            eprintln!("TARGET is required: {error}");
            std::process::exit(1);
        }
    }
}

fn deployment_target() -> String {
    let deployment = std::env::var("MACOSX_DEPLOYMENT_TARGET").unwrap_or_else(|_| "10.15".into());
    let supported = deployment
        .split_once('.')
        .and_then(|(major, minor)| Some((major.parse::<u32>().ok()?, minor.parse::<u32>().ok()?)))
        .is_some_and(|version| version >= (10, 15));
    if supported {
        deployment
    } else {
        eprintln!("MACOSX_DEPLOYMENT_TARGET must be 10.15 or newer");
        std::process::exit(1);
    }
}

fn run(command: &mut Command, label: &str) {
    match command.status() {
        Ok(status) if status.success() => {}
        Ok(status) => {
            eprintln!("{label} failed with {status}");
            std::process::exit(1);
        }
        Err(error) => {
            eprintln!("{label}: {error}");
            std::process::exit(1);
        }
    }
}
