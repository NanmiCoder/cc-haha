use agent_desktop_core::{AdapterError, ErrorCode, system::launch_options::LaunchOptions};
use std::collections::BTreeMap;
use std::path::PathBuf;

const MAX_ARGUMENT_COUNT: usize = 256;
const MAX_ENVIRONMENT_COUNT: usize = 256;
const MAX_LAUNCH_TEXT_BYTES: usize = 1024 * 1024;

pub(super) fn launch_identifier(id: &str) -> Result<String, AdapterError> {
    if id.is_empty() || id.contains("..") || id.chars().any(char::is_control) {
        return Err(invalid_identifier(id));
    }
    if is_absolute_launch_path(id) {
        return Ok(id.to_owned());
    }
    if is_bare_name(id) {
        if std::path::Path::new(id).extension().is_some() {
            return Ok(id.to_owned());
        }
        return Ok(format!("{id}.exe"));
    }
    Err(invalid_identifier(id))
}

pub(super) fn validate_launch_options(options: &LaunchOptions) -> Result<(), AdapterError> {
    if options.args.len() > MAX_ARGUMENT_COUNT || options.env.len() > MAX_ENVIRONMENT_COUNT {
        return Err(AdapterError::new(
            ErrorCode::InvalidArgs,
            "Launch argument or environment entry count exceeds the supported limit",
        ));
    }
    let text_bytes = options
        .args
        .iter()
        .map(String::len)
        .chain(
            options
                .env
                .iter()
                .map(|(key, value)| key.len() + value.len()),
        )
        .try_fold(0_usize, usize::checked_add)
        .ok_or_else(|| AdapterError::new(ErrorCode::InvalidArgs, "Launch options are too large"))?;
    if text_bytes > MAX_LAUNCH_TEXT_BYTES {
        return Err(AdapterError::new(
            ErrorCode::InvalidArgs,
            "Launch argument and environment data exceeds one MiB",
        ));
    }
    Ok(())
}

pub(crate) fn resolve_executable(id: &str) -> Result<PathBuf, AdapterError> {
    if is_absolute_launch_path(id) {
        let path = PathBuf::from(id);
        if path.is_file() {
            return Ok(path);
        }
        return Err(
            AdapterError::new(ErrorCode::AppNotFound, "Launch path does not exist")
                .with_details(serde_json::json!({ "app_name": id })),
        );
    }
    if !is_bare_name(id) {
        return Err(invalid_identifier(id));
    }
    let (system32, windows) = system_directories()?;
    for directory in [system32, windows] {
        let candidate = directory.join(id);
        if candidate.is_file() {
            return Ok(candidate);
        }
    }
    Err(AdapterError::new(
        ErrorCode::AppNotFound,
        "Bare launch name is not present in the system directories",
    )
    .with_details(serde_json::json!({ "app_name": id }))
    .with_suggestion(
        "Pass an absolute path, or a bare name that exists under System32 or the Windows directory.",
    ))
}

pub(super) fn image_file_name(id: &str) -> &str {
    id.rsplit(['\\', '/']).next().unwrap_or(id)
}

/// Windows environment variable names are case-insensitive: a caller
/// overriding `Path` while the parent process carries `PATH` must replace
/// that entry outright, or the child inherits both and resolves whichever
/// one happens to sort first. Keys are folded to ASCII uppercase only to
/// detect that collision; the spelling that lands in the block is always
/// the caller's own for an override, or the inherited spelling otherwise.
pub(super) fn environment_block(
    overrides: &BTreeMap<String, String>,
) -> Result<Vec<u16>, AdapterError> {
    let mut block = Vec::new();
    for (key, value) in merge_environment(std::env::vars(), overrides)? {
        block.extend(format!("{key}={value}").encode_utf16());
        block.push(0);
    }
    block.push(0);
    Ok(block)
}

/// Folds the inherited environment and caller overrides into one entry list.
///
/// Inherited entries with malformed names - empty, or containing `=` or NUL,
/// the hidden current-directory variables some Windows images carry in their
/// process environment - are skipped rather than fatal: this process did not
/// choose them, and one stray machine-level entry must not fail every launch
/// on that machine. Caller overrides are held to the strict rule instead,
/// because a rejected launch with `InvalidArgs` is the honest answer to input
/// this tool was handed directly. The returned keys are still folded to ASCII
/// uppercase for collision detection; values keep their inherited spelling.
pub(super) fn merge_environment(
    inherited: impl Iterator<Item = (String, String)>,
    overrides: &BTreeMap<String, String>,
) -> Result<Vec<(String, String)>, AdapterError> {
    let mut merged: BTreeMap<String, (String, String)> = inherited
        .filter(|(key, _)| !key.is_empty() && !key.contains('=') && !key.contains('\0'))
        .map(|(key, value)| (key.to_ascii_uppercase(), (key, value)))
        .collect();
    for (key, value) in overrides {
        merged.insert(key.to_ascii_uppercase(), (key.clone(), value.clone()));
    }
    let entries: Vec<(String, String)> = merged.into_values().collect();
    for (key, value) in &entries {
        if key.contains('=') || key.contains('\0') || value.contains('\0') {
            return Err(AdapterError::new(
                ErrorCode::InvalidArgs,
                "Launch environment entries must not contain NUL or '=' in the key",
            ));
        }
    }
    Ok(entries)
}

/// The block a launch actually hands to `CreateProcessW`: `None` only when
/// nothing needs to change from this process's own environment - no caller
/// override, and this process itself carries no entry for `strip_key` to
/// remove. Any other case builds an explicit block with `strip_key` scrubbed
/// unconditionally, so a value this process only holds because it was
/// handed down to it (an adopted lease handle, say) never reaches a process
/// this launch starts, whether or not the caller supplied overrides of its
/// own.
pub(super) fn child_environment_block(
    overrides: &BTreeMap<String, String>,
    strip_key: &str,
) -> Result<Option<Vec<u16>>, AdapterError> {
    if overrides.is_empty() && std::env::var_os(strip_key).is_none() {
        return Ok(None);
    }
    let block = environment_block(overrides)?;
    Ok(Some(strip_env_entry(block, strip_key)))
}

/// Removes any entry named `key` from an already-encoded `CreateProcessW`
/// environment block, comparing the name case-insensitively the way Windows
/// resolves environment variable names. Round-trips through `String` rather
/// than walking the UTF-16 units directly: every entry in a block this
/// module built started as a valid Rust `String` with no interior NUL
/// (`environment_block` rejects that), so the decode is exact, not lossy in
/// practice.
fn strip_env_entry(block: Vec<u16>, key: &str) -> Vec<u16> {
    let text = String::from_utf16_lossy(&block);
    let folded_prefix = format!("{}=", key.to_ascii_uppercase());
    let mut out = Vec::with_capacity(block.len());
    for entry in text.split('\0') {
        if entry.is_empty() || entry.to_ascii_uppercase().starts_with(&folded_prefix) {
            continue;
        }
        out.extend(entry.encode_utf16());
        out.push(0);
    }
    out.push(0);
    out
}

fn system_directories() -> Result<(PathBuf, PathBuf), AdapterError> {
    let root = std::env::var_os("SystemRoot")
        .or_else(|| std::env::var_os("WINDIR"))
        .ok_or_else(|| AdapterError::internal("SystemRoot is unset"))?;
    let windows = PathBuf::from(root);
    let system32 = windows.join("System32");
    Ok((system32, windows))
}

fn is_absolute_launch_path(id: &str) -> bool {
    if id.starts_with(r"\\?\") || id.starts_with(r"\\") {
        return true;
    }
    let bytes = id.as_bytes();
    bytes.len() >= 3 && bytes[0].is_ascii_alphabetic() && bytes[1] == b':' && bytes[2] == b'\\'
}

fn is_bare_name(id: &str) -> bool {
    if id.is_empty() || id.contains(['\\', '/']) {
        return false;
    }
    let bytes = id.as_bytes();
    if bytes.len() >= 2 && bytes[0].is_ascii_alphabetic() && bytes[1] == b':' {
        return false;
    }
    true
}

fn invalid_identifier(id: &str) -> AdapterError {
    AdapterError::new(
        ErrorCode::InvalidArgs,
        "Invalid app identifier: use an absolute path or a bare executable name",
    )
    .with_details(serde_json::json!({ "app_name": id }))
    .with_suggestion(
        "Use a full path (drive + backslash, UNC, or \\\\?\\) or a bare name resolved only under System32 / Windows.",
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn absolute_and_bare_names_are_accepted() {
        assert!(launch_identifier(r"C:\Windows\System32\notepad.exe").is_ok());
        assert!(launch_identifier(r"\\?\C:\Windows\notepad.exe").is_ok());
        assert!(launch_identifier(r"\\server\share\app.exe").is_ok());
        assert!(launch_identifier("notepad.exe").is_ok());
    }

    #[test]
    fn a_bare_name_without_an_extension_names_its_exe_image() {
        assert_eq!(launch_identifier("notepad").unwrap(), "notepad.exe");
        assert_eq!(launch_identifier("notepad.exe").unwrap(), "notepad.exe");
        assert_eq!(launch_identifier("mmc.msc").unwrap(), "mmc.msc");
        assert_eq!(launch_identifier(r"C:\Tools\app").unwrap(), r"C:\Tools\app");
    }

    #[test]
    fn relative_and_unsafe_identifiers_are_rejected() {
        for identifier in [
            "",
            "..\\evil.exe",
            "sub\\app.exe",
            ".\\app.exe",
            "\\app.exe",
            "C:app.exe",
            "bad\0name",
            "bad\nname",
        ] {
            let error = launch_identifier(identifier).expect_err("unsafe identifier");
            assert_eq!(error.code, ErrorCode::InvalidArgs);
        }
    }

    /// Pins the fast path a launch with no overrides takes when this process
    /// itself carries nothing that needs stripping: reverting
    /// `child_environment_block`'s guard back to `overrides.is_empty()` alone
    /// (dropping the `var_os` check) would still pass this one, since it
    /// asserts the `None` side; the sibling test below is what that
    /// regression actually breaks.
    #[test]
    fn child_environment_block_is_none_when_nothing_needs_changing() {
        let key = format!(
            "AGENT_DESKTOP_LAUNCH_PATH_TEST_ABSENT_{}",
            std::process::id()
        );
        unsafe { std::env::remove_var(&key) };
        let overrides = BTreeMap::new();
        let block = child_environment_block(&overrides, &key).expect("decision");
        assert!(
            block.is_none(),
            "no override and no inherited entry to strip must skip building an explicit block"
        );
    }

    /// **Invert-verified**: reverting `child_environment_block`'s guard to
    /// `overrides.is_empty()` alone makes this fail - an inherited
    /// `strip_key` entry with empty overrides then takes the `None` branch
    /// and the stale value reaches `CreateProcessW` verbatim through the
    /// null environment pointer.
    #[test]
    fn child_environment_block_strips_an_inherited_strip_key_even_with_empty_overrides() {
        let key = format!(
            "AGENT_DESKTOP_LAUNCH_PATH_TEST_STRIP_{}",
            std::process::id()
        );
        unsafe { std::env::set_var(&key, "stale-handle-value") };
        let overrides = BTreeMap::new();
        let block = child_environment_block(&overrides, &key)
            .expect("decision")
            .expect("an inherited strip_key entry forces an explicit block");
        unsafe { std::env::remove_var(&key) };
        let text = String::from_utf16_lossy(&block);
        let folded_prefix = format!("{}=", key.to_ascii_uppercase());
        assert!(
            !text
                .split('\0')
                .any(|entry| entry.to_ascii_uppercase().starts_with(&folded_prefix)),
            "the strip_key entry must not survive into the built block: {text:?}"
        );
    }

    /// **Invert-verified**: removing the inherited-entry filter makes this
    /// fail with the `InvalidArgs` error every launch on a machine whose
    /// environment carries a malformed hidden variable (an `=C:=`-style
    /// current-directory entry) produced on the ARM64 hosted runner.
    #[test]
    fn malformed_inherited_entries_are_skipped_not_fatal() {
        let inherited = vec![
            ("=C:".to_string(), "C:\\hidden".to_string()),
            ("Path".to_string(), "kept".to_string()),
        ];
        let merged = merge_environment(inherited.into_iter(), &BTreeMap::new())
            .expect("a malformed inherited entry is skipped, not fatal");
        assert_eq!(merged.len(), 1);
        assert_eq!(merged[0].0, "Path", "inherited spelling is preserved");
        assert_eq!(merged[0].1, "kept");
    }

    /// Caller-supplied overrides keep the strict rule the inherited filter
    /// relaxed: a launch handed a malformed name directly must refuse.
    #[test]
    fn override_keys_still_reject_invalid_names() {
        let mut overrides = BTreeMap::new();
        overrides.insert("BAD=KEY".to_string(), "value".to_string());
        let error = merge_environment(std::env::vars(), &overrides).expect_err("invalid override");
        assert_eq!(error.code, ErrorCode::InvalidArgs);
    }
}
