use crate::{
    refs::refs_lock::RefStoreLock, refs::write_private_file,
    storage::private_file::read_private_bounded,
};
use std::path::Path;
use std::time::Duration;

const SCREENSHOT_BYTE_BUDGET: u64 = 128 * 1024 * 1024;
const SCREENSHOT_COUNT_BUDGET: u32 = 200;
const REFMAP_BYTE_BUDGET: u64 = 64 * 1024 * 1024;
const USAGE_LEDGER_FILE: &str = ".artifact-usage.json";
const USAGE_LEDGER_MAX_BYTES: u64 = 256;
const ARTIFACT_LOCK_FILE: &str = ".artifact-budget.lock";

/// Waiting for the artifact ledger lock is observability work, and observability
/// must never spend the budget of the action it observes. The wait is therefore
/// bounded by its own fixed window, additionally clamped to whatever the caller
/// still has left, and a lock that cannot be taken inside that window skips the
/// capture rather than stalling the action behind it.
///
/// 50 ms is deliberate on both sides. An uncontended acquire measured on this
/// hardware costs 68 us at best, 72 us typically, and 1.8 ms at the worst of two
/// hundred samples, and a contended acquire re-polls every 10 ms, so 50 ms buys
/// five attempts. It also clears the 31 ms median span for which a concurrent
/// 2 MB screenshot write holds the lock, so two simultaneous captures usually
/// both land and only a tail write costs the loser its capture. On the other
/// side it is half the dispatch reserve the pre-capture path already withholds,
/// so losing the wait outright moves the observed action's own budget by less
/// than the slack that path exists to keep.
const ARTIFACT_LOCK_WAIT_MS: u64 = 50;

#[derive(Clone, Copy)]
struct ArtifactLimits {
    screenshot_bytes: u64,
    screenshot_count: u32,
    refmap_bytes: u64,
}

#[cfg(test)]
thread_local! {
    static TEST_LIMITS: std::cell::Cell<Option<ArtifactLimits>> = const { std::cell::Cell::new(None) };
    static TEST_SCAN_COUNT: std::cell::Cell<u32> = const { std::cell::Cell::new(0) };
}

#[cfg(test)]
pub(crate) fn set_test_limits(screenshot_bytes: u64, screenshot_count: u32, refmap_bytes: u64) {
    TEST_LIMITS.with(|limits| {
        limits.set(Some(ArtifactLimits {
            screenshot_bytes,
            screenshot_count,
            refmap_bytes,
        }));
    });
}

#[cfg(test)]
pub(crate) fn clear_test_limits() {
    TEST_LIMITS.with(|limits| limits.set(None));
}

#[cfg(test)]
fn reset_test_scan_count() {
    TEST_SCAN_COUNT.with(|count| count.set(0));
}

#[cfg(test)]
fn test_scan_count() -> u32 {
    TEST_SCAN_COUNT.with(std::cell::Cell::get)
}

pub(crate) fn write_screenshot(
    trace_dir: &Path,
    path: &Path,
    bytes: &[u8],
    deadline: crate::Deadline,
) -> Result<(), &'static str> {
    let _lock = artifact_lock_with_deadline(trace_dir, deadline)?;
    let limits = limits();
    let usage = load_usage(trace_dir)?;
    if usage.1 >= limits.screenshot_count {
        return Err("count_budget");
    }
    if usage.0.saturating_add(bytes.len() as u64) > limits.screenshot_bytes {
        return Err("budget");
    }
    let reserved = (
        usage.0.saturating_add(bytes.len() as u64),
        usage.1.saturating_add(1),
        usage.2,
    );
    persist_usage(trace_dir, reserved)?;
    if write_private_file(path, bytes).is_err() {
        rollback_reservation_if_absent(trace_dir, path, usage);
        return Err("write_failed");
    }
    Ok(())
}

pub(crate) fn write_refmap_if_absent(
    trace_dir: &Path,
    path: &Path,
    bytes: &[u8],
) -> Result<(), &'static str> {
    let _lock = artifact_lock(trace_dir)?;
    if path.is_file() {
        return Ok(());
    }
    let usage = load_usage(trace_dir)?;
    if usage.2.saturating_add(bytes.len() as u64) > limits().refmap_bytes {
        return Err("budget");
    }
    let reserved = (usage.0, usage.1, usage.2.saturating_add(bytes.len() as u64));
    persist_usage(trace_dir, reserved)?;
    if write_private_file(path, bytes).is_err() {
        rollback_reservation_if_absent(trace_dir, path, usage);
        return Err("write_failed");
    }
    Ok(())
}

/// The refmap copy is handed no deadline of its own, so it takes the same fixed
/// capture window through `Deadline::after`, which already folds in whatever
/// command-scope deadline is in force and so clamps the wait to the caller's
/// remaining time exactly as the screenshot path does.
fn artifact_lock(trace_dir: &Path) -> Result<RefStoreLock, &'static str> {
    let deadline = crate::Deadline::after(ARTIFACT_LOCK_WAIT_MS).map_err(|_| "lock_failed")?;
    acquire_artifact_lock(trace_dir, deadline)
}

fn artifact_lock_with_deadline(
    trace_dir: &Path,
    deadline: crate::Deadline,
) -> Result<RefStoreLock, &'static str> {
    acquire_artifact_lock(trace_dir, capture_lock_deadline(deadline))
}

fn capture_lock_deadline(caller: crate::Deadline) -> crate::Deadline {
    caller.capped(Duration::from_millis(ARTIFACT_LOCK_WAIT_MS))
}

fn acquire_artifact_lock(
    trace_dir: &Path,
    deadline: crate::Deadline,
) -> Result<RefStoreLock, &'static str> {
    RefStoreLock::acquire_with_deadline(&trace_dir.join(ARTIFACT_LOCK_FILE), deadline)
        .map_err(|_| "lock_failed")
}

fn load_usage(trace_dir: &Path) -> Result<(u64, u32, u64), &'static str> {
    let ledger = trace_dir.join(USAGE_LEDGER_FILE);
    if let Ok(bytes) = read_private_bounded(&ledger, USAGE_LEDGER_MAX_BYTES)
        && let Some(usage) = decode_usage(&bytes)
    {
        return Ok(usage);
    }
    let (screenshot_bytes, screenshot_count) = directory_usage(&trace_dir.join("screens"))?;
    let (refmap_bytes, _) = directory_usage(&trace_dir.join("refmaps"))?;
    let usage = (screenshot_bytes, screenshot_count, refmap_bytes);
    persist_usage(trace_dir, usage)?;
    Ok(usage)
}

fn decode_usage(bytes: &[u8]) -> Option<(u64, u32, u64)> {
    let value: serde_json::Value = serde_json::from_slice(bytes).ok()?;
    Some((
        value.get("screenshot_bytes")?.as_u64()?,
        u32::try_from(value.get("screenshot_count")?.as_u64()?).ok()?,
        value.get("refmap_bytes")?.as_u64()?,
    ))
}

fn persist_usage(trace_dir: &Path, usage: (u64, u32, u64)) -> Result<(), &'static str> {
    let bytes = serde_json::to_vec(&serde_json::json!({
        "screenshot_bytes": usage.0,
        "screenshot_count": usage.1,
        "refmap_bytes": usage.2,
    }))
    .map_err(|_| "ledger_failed")?;
    write_private_file(&trace_dir.join(USAGE_LEDGER_FILE), &bytes).map_err(|_| "ledger_failed")
}

fn rollback_reservation_if_absent(trace_dir: &Path, path: &Path, usage: (u64, u32, u64)) {
    let artifact_may_exist = path
        .symlink_metadata()
        .is_ok_and(|metadata| metadata.file_type().is_file() || metadata.file_type().is_symlink());
    if !artifact_may_exist {
        let _ = persist_usage(trace_dir, usage);
    }
}

fn directory_usage(dir: &Path) -> Result<(u64, u32), &'static str> {
    #[cfg(test)]
    TEST_SCAN_COUNT.with(|count| count.set(count.get().saturating_add(1)));
    let entries = match std::fs::read_dir(dir) {
        Ok(entries) => entries,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok((0, 0)),
        Err(_) => return Err("scan_failed"),
    };
    let mut bytes = 0_u64;
    let mut count = 0_u32;
    for entry in entries {
        let entry = entry.map_err(|_| "scan_failed")?;
        let metadata = entry.path().symlink_metadata().map_err(|_| "scan_failed")?;
        if metadata.file_type().is_symlink() {
            return Err("scan_failed");
        }
        if metadata.is_file() {
            bytes = bytes.saturating_add(metadata.len());
            count = count.saturating_add(1);
        }
    }
    Ok((bytes, count))
}

fn limits() -> ArtifactLimits {
    #[cfg(test)]
    if let Some(limits) = TEST_LIMITS.with(std::cell::Cell::get) {
        return limits;
    }
    ArtifactLimits {
        screenshot_bytes: SCREENSHOT_BYTE_BUDGET,
        screenshot_count: SCREENSHOT_COUNT_BUDGET,
        refmap_bytes: REFMAP_BYTE_BUDGET,
    }
}

#[cfg(test)]
#[path = "trace_artifact_budget_tests.rs"]
mod tests;
