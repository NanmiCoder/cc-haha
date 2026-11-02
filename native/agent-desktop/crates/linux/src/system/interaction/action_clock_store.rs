use std::fs;
use std::path::{Path, PathBuf};

use crate::system::app::runtime_store::{runtime_subdir, write_private_atomically};

const DIR_NAME: &str = "agent-desktop-actions";
const NO_TOKEN: &str = "-";
const KEEP_MS: u64 = 60_000;

fn runtime_dir() -> Option<PathBuf> {
    if cfg!(test) {
        return None;
    }
    runtime_subdir(DIR_NAME)
}

/// Milliseconds since the machine booted, suspend included, so two processes
/// agree on it and a restart cannot make an old entry look new.
fn boot_ms() -> Option<u64> {
    let text = fs::read_to_string("/proc/uptime").ok()?;
    let seconds: f64 = text.split_whitespace().next()?.parse().ok()?;
    Some((seconds * 1000.0) as u64)
}

fn token_of(pid: u32) -> Option<String> {
    crate::system::process::process_facts::read(pid).map(|facts| facts.instance)
}

fn encode(at_ms: u64, token: &str) -> String {
    format!("{at_ms} {token}\n")
}

fn parse(text: &str) -> Option<(u64, &str)> {
    let mut parts = text.split_whitespace();
    let at = parts.next()?.parse().ok()?;
    Some((at, parts.next()?))
}

fn is_fresh(at_ms: u64, now_ms: u64, window_ms: u64) -> bool {
    now_ms >= at_ms && now_ms - at_ms < window_ms
}

fn is_stale(
    path: &Path,
    name: &str,
    now_ms: u64,
    token_now: &dyn Fn(u32) -> Option<String>,
) -> bool {
    let text = fs::read_to_string(path).unwrap_or_default();
    match parse(&text) {
        None => true,
        Some((at, token)) => {
            !is_fresh(at, now_ms, KEEP_MS)
                || name
                    .parse::<u32>()
                    .is_ok_and(|pid| token_now(pid).as_deref() != Some(token))
        }
    }
}

fn is_old_scratch(path: &Path) -> bool {
    fs::metadata(path)
        .and_then(|meta| meta.modified())
        .ok()
        .and_then(|modified| modified.elapsed().ok())
        .is_some_and(|age| age.as_millis() > u128::from(KEEP_MS))
}

/// Removes records that are old or whose process is gone. A pending file is
/// another invocation's record in the middle of being written, so it is left
/// alone unless it has sat there far longer than a write takes.
fn prune(dir: &Path, now_ms: u64, token_now: &dyn Fn(u32) -> Option<String>) {
    let Ok(entries) = fs::read_dir(dir) else {
        return;
    };
    for entry in entries.flatten() {
        let name = entry.file_name().to_string_lossy().into_owned();
        let path = entry.path();
        let remove = if name.ends_with(".tmp") {
            is_old_scratch(&path)
        } else {
            is_stale(&path, &name, now_ms, token_now) && is_stale(&path, &name, now_ms, token_now)
        };
        if remove {
            let _ = fs::remove_file(&path);
        }
    }
}

pub(in crate::system) fn record_in(
    dir: &Path,
    pid: u32,
    now_ms: u64,
    token_now: &dyn Fn(u32) -> Option<String>,
) {
    let token = token_now(pid).unwrap_or_else(|| NO_TOKEN.to_owned());
    prune(dir, now_ms, token_now);
    let _ = write_private_atomically(
        dir,
        &dir.join(pid.to_string()),
        encode(now_ms, &token).as_bytes(),
    );
}

pub(in crate::system) fn recent_in(
    dir: &Path,
    pid: u32,
    now_ms: u64,
    window_ms: u64,
    token_now: &dyn Fn(u32) -> Option<String>,
) -> bool {
    let Ok(text) = fs::read_to_string(dir.join(pid.to_string())) else {
        return false;
    };
    let Some((at, token)) = parse(&text) else {
        return false;
    };
    token_now(pid).as_deref() == Some(token) && is_fresh(at, now_ms, window_ms)
}

/// Writes that an action was just delivered to the process. A directory that
/// cannot be written leaves no record, which reads as no recent action.
pub(in crate::system) fn record(pid: u32) {
    if let (Some(dir), Some(now)) = (runtime_dir(), boot_ms()) {
        record_in(&dir, pid, now, &token_of);
    }
}

pub(in crate::system) fn recent(pid: u32, window_ms: u64) -> bool {
    match (runtime_dir(), boot_ms()) {
        (Some(dir), Some(now)) => recent_in(&dir, pid, now, window_ms, &token_of),
        _ => false,
    }
}

#[cfg(test)]
#[path = "action_clock_store_tests.rs"]
mod tests;
