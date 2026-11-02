//! Dev-box evidence tool: dumps a window's UI Automation tree as JSON through
//! the same COM client, walker, property reader and cache policy the adapter
//! ships.
//!
//! Earlier committed dumps were taken on the **managed** stack, which A2-4
//! measured reporting the identical Notepad window as 3 nodes against 26 on
//! the COM stack. This tool exists so evidence is captured in the stack the
//! product actually uses, and it records the target variant, OS build and
//! client stack that those earlier dumps lacked.
//!
//! Host data is normalised before writing, as those earlier captures already do:
//! process ids, provider ids, window handles and user paths are substituted,
//! and `Name` is recorded as presence and length only.
//!
//! ```text
//! cargo run -p agent-desktop-windows --example uia_tree_dump -- \
//!     --class Notepad --variant "classic Win32 Notepad" --out notepad-com.json
//! ```

#[cfg(target_os = "windows")]
#[path = "uia_tree_dump/select.rs"]
mod select;

#[cfg(target_os = "windows")]
#[path = "uia_tree_dump/render_slots.rs"]
mod render_slots;

#[cfg(target_os = "windows")]
#[path = "uia_tree_dump/profile_path.rs"]
mod profile_path;

#[cfg(target_os = "windows")]
#[path = "uia_tree_dump/render_node.rs"]
mod render_node;

#[cfg(target_os = "windows")]
#[path = "uia_tree_dump/render_census.rs"]
mod render_census;

#[cfg(target_os = "windows")]
#[path = "uia_tree_dump/render.rs"]
mod render;

#[cfg(target_os = "windows")]
fn main() -> std::process::ExitCode {
    match run() {
        Ok(path) => {
            println!("wrote {path}");
            std::process::ExitCode::SUCCESS
        }
        Err(reason) => {
            eprintln!("{}", render_slots::skipped(&reason));
            std::process::ExitCode::FAILURE
        }
    }
}

#[cfg(target_os = "windows")]
fn run() -> Result<String, String> {
    use agent_desktop_core::Deadline;
    use agent_desktop_windows::tree::automation::root_from_hwnd;

    let options = select::Options::from_args()?;
    agent_desktop_windows::ensure_owned_process_mta_and_dpi().map_err(|error| {
        format!(
            "the COM apartment could not be established: {}",
            error.message
        )
    })?;

    let handle = select::find_window(&options)?;
    let deadline = Deadline::after(30_000).map_err(|error| error.message.clone())?;
    let root = root_from_hwnd(handle, deadline).map_err(|error| {
        format!(
            "the selected window did not resolve to a UI Automation root: {} ({})",
            error.message,
            error.platform_detail.unwrap_or_default()
        )
    })?;

    let document = render::dump(&root, handle, &options, deadline)?;
    std::fs::write(&options.output, document).map_err(|error| error.to_string())?;
    Ok(options.output.clone())
}

/// The example is compiled by `cargo check --all-targets` on every lane, and
/// every item above is gated behind Windows because it reaches the
/// target-gated `uiautomation` dependency. This stub is what keeps the Linux
/// and macOS gates green.
#[cfg(not(target_os = "windows"))]
fn main() {
    eprintln!("uia_tree_dump captures UI Automation evidence and runs on Windows only");
}
