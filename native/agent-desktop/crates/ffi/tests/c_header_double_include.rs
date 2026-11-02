//! Regression test: including `agent_desktop.h` twice in one translation unit
//! must not produce a compilation error.
//!
//! The header emits `_Static_assert` blocks outside its `AGENT_DESKTOP_H`
//! include guard (cbindgen places the trailer after the closing `#endif`).
//! C11 §6.7.10 allows repeated file-scope `_Static_assert` declarations, so a
//! bare double-include is legal; the `AGENT_DESKTOP_ABI_ASSERTS` one-shot guard
//! in the trailer makes this unambiguously safe in all C standards.
//!
//! If this test starts failing, check that the cbindgen.toml trailer still
//! wraps its `_Static_assert` block in `#ifndef AGENT_DESKTOP_ABI_ASSERTS`.
//!
//! The test shells out to the system `cc`; it skips on platforms where
//! that binary is not on PATH so cargo test still passes on bare CI images.

#[path = "common/header_temp.rs"]
mod header_temp;

use std::path::PathBuf;
use std::process::Command;

fn system_cc() -> Option<&'static str> {
    let cc = if cfg!(target_os = "windows") {
        "cl"
    } else {
        "cc"
    };
    Command::new(cc)
        .arg("--version")
        .output()
        .ok()
        .filter(|o| o.status.success())
        .map(|_| cc)
}

fn header_include_dir() -> PathBuf {
    let mut p = PathBuf::from(env!("CARGO_MANIFEST_DIR"));
    p.push("include");
    p
}

#[test]
fn committed_header_survives_double_include() {
    let cc = match system_cc() {
        Some(cc) => cc,
        None => {
            eprintln!("skipping: system C compiler not found");
            return;
        }
    };

    let directory = header_temp::HeaderTemp::new();
    let tmp = directory.0.join("header.c");
    let obj = directory.0.join("header.o");
    let src = r#"
#include <stdint.h>
#include <stdbool.h>
#include <stddef.h>
#include "agent_desktop.h"
#include "agent_desktop.h"

int check(void) { return 0; }
"#;
    std::fs::write(&tmp, src).expect("write test translation unit");

    let include = header_include_dir();
    let status = Command::new(cc)
        .arg("-Wall")
        .arg("-Werror")
        .arg("-I")
        .arg(&include)
        .arg("-c")
        .arg(&tmp)
        .arg("-o")
        .arg(&obj)
        .status()
        .expect("cc invocation failed");

    let _ = std::fs::remove_file(&tmp);
    let _ = std::fs::remove_file(&obj);

    assert!(
        status.success(),
        "Double-include of agent_desktop.h failed to compile. \
         Ensure the cbindgen.toml trailer wraps _Static_assert blocks in \
         #ifndef AGENT_DESKTOP_ABI_ASSERTS so they are not re-emitted on a \
         second include."
    );
}
