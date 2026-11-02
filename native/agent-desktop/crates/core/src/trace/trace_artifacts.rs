use crate::{
    AppError,
    adapter::{PlatformAdapter, ScreenshotTarget},
    context::CommandContext,
    refs::refs_store::RefStore,
    refs::{RefEntry, RefMap, is_symlink},
    trace::{ensure_trace_dir, process_start_ms},
};
use serde_json::json;
use std::path::{Component, Path, PathBuf};
use std::sync::atomic::{AtomicU32, Ordering};

static CAPTURE_SEQ: AtomicU32 = AtomicU32::new(0);
const MAX_EMBED_SCREENSHOT_BYTES: u64 = 128 * 1024 * 1024;

#[cfg(test)]
pub(crate) fn set_test_budgets(screenshot_bytes: u64, screenshot_count: u32, refmap_bytes: u64) {
    crate::trace::trace_artifact_budget::set_test_limits(
        screenshot_bytes,
        screenshot_count,
        refmap_bytes,
    );
}

#[cfg(test)]
pub(crate) fn clear_test_budgets() {
    crate::trace::trace_artifact_budget::clear_test_limits();
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) enum ArtifactOutcome {
    Captured(String),
    Skipped(String),
}

fn artifacts_enabled(context: &CommandContext) -> bool {
    context.trace_enabled() && context.artifacts_full()
}

fn session_trace_dir(context: &CommandContext) -> Option<PathBuf> {
    let session_id = context.session_id()?;
    let store = RefStore::for_session(Some(session_id)).ok()?;
    Some(store.trace_dir())
}

fn screens_dir(trace_dir: &Path) -> PathBuf {
    trace_dir.join("screens")
}

pub(crate) fn refmap_artifact_dir(trace_dir: &Path) -> PathBuf {
    refmaps_dir(trace_dir)
}

fn refmaps_dir(trace_dir: &Path) -> PathBuf {
    trace_dir.join("refmaps")
}

fn relative_to_trace(trace_dir: &Path, path: &Path) -> String {
    path.strip_prefix(trace_dir)
        .map(|rel| rel.to_string_lossy().replace('\\', "/"))
        .unwrap_or_else(|_| path.to_string_lossy().into_owned())
}

pub(crate) fn capture_action_screenshot(
    context: &CommandContext,
    adapter: &dyn PlatformAdapter,
    entry: &RefEntry,
    phase: &str,
    deadline: crate::Deadline,
) -> ArtifactOutcome {
    if !artifacts_enabled(context) {
        return ArtifactOutcome::Skipped("disabled".into());
    }
    if deadline.is_expired() {
        return ArtifactOutcome::Skipped("deadline".into());
    }
    let Some(window_id) = entry
        .source
        .source_window_id
        .as_deref()
        .filter(|window_id| !window_id.is_empty())
    else {
        return ArtifactOutcome::Skipped("exact_target_unavailable".into());
    };
    let Some(process_instance) = entry
        .process
        .process_instance
        .as_deref()
        .filter(|instance| !instance.is_empty())
    else {
        return ArtifactOutcome::Skipped("exact_target_unavailable".into());
    };
    let Some(trace_dir) = session_trace_dir(context) else {
        return ArtifactOutcome::Skipped("no_session".into());
    };
    let screens = screens_dir(&trace_dir);
    if let Err(err) = ensure_trace_dir(&screens) {
        return ArtifactOutcome::Skipped(format!("dir: {err}"));
    }

    let target = crate::WindowInfo {
        id: window_id.into(),
        title: entry.source.source_window_title.clone().unwrap_or_default(),
        app: entry.source.source_app.clone().unwrap_or_default(),
        pid: entry.process.pid,
        process_instance: Some(process_instance.into()),
        bounds: None,
        state: crate::WindowState {
            is_focused: false,
            ..Default::default()
        },
    };
    let buf = match adapter.screenshot(ScreenshotTarget::ExactWindow(target), deadline) {
        Ok(buf) => buf,
        Err(err) => {
            return ArtifactOutcome::Skipped(format!("adapter: {}", err.code.as_str()));
        }
    };
    let seq = CAPTURE_SEQ.fetch_add(1, Ordering::Relaxed);
    let filename = format!(
        "{}-{}-{}-{}.png",
        entry.process.pid,
        process_start_ms(),
        seq,
        phase
    );
    let path = screens.join(&filename);
    if let Err(reason) = crate::trace::trace_artifact_budget::write_screenshot(
        &trace_dir, &path, &buf.data, deadline,
    ) {
        return ArtifactOutcome::Skipped(reason.into());
    }
    ArtifactOutcome::Captured(relative_to_trace(&trace_dir, &path))
}

pub(crate) fn copy_refmap_if_full(
    context: &CommandContext,
    store: &RefStore,
    snapshot_id: &str,
    refmap: &RefMap,
) -> Result<(), AppError> {
    if !artifacts_enabled(context) {
        return Ok(());
    }
    let trace_dir = store.trace_dir();
    let refmaps = refmaps_dir(&trace_dir);
    if let Err(err) = ensure_trace_dir(&refmaps) {
        tracing::warn!("refmap artifact dir unavailable: {err}");
        return Ok(());
    }
    let dest = refmaps.join(format!("{snapshot_id}.json"));
    let json = match refmap.serialize_with_size_check() {
        Ok(json) => json,
        Err(err) => {
            tracing::warn!("refmap artifact serialize failed: {err}");
            return Ok(());
        }
    };
    if crate::trace::trace_artifact_budget::write_refmap_if_absent(
        &trace_dir,
        &dest,
        json.as_bytes(),
    )
    .is_err()
    {
        let _ = context.trace_lazy(
            "action.artifacts.refmap_skipped",
            || json!({ "snapshot_id": snapshot_id }),
        );
        return Ok(());
    }
    Ok(())
}

pub(crate) fn emit_action_artifacts(
    context: &CommandContext,
    ref_id: &str,
    pre: &ArtifactOutcome,
    post: &ArtifactOutcome,
) -> Result<(), AppError> {
    if !artifacts_enabled(context) {
        return Ok(());
    }
    let same_skip = match (pre, post) {
        (ArtifactOutcome::Skipped(a), ArtifactOutcome::Skipped(b)) if a == b && a != "disabled" => {
            Some(a.as_str())
        }
        _ => None,
    };
    if let Some(reason) = same_skip {
        return context.trace(
            "action.artifacts",
            json!({ "ref": ref_id, "skipped": reason }),
        );
    }
    let mut fields = json!({ "ref": ref_id });
    match pre {
        ArtifactOutcome::Captured(path) => fields["screenshot_pre"] = json!(path),
        ArtifactOutcome::Skipped(reason) if reason != "disabled" => {
            fields["skipped_pre"] = json!(reason);
        }
        _ => {}
    }
    match post {
        ArtifactOutcome::Captured(path) => fields["screenshot_post"] = json!(path),
        ArtifactOutcome::Skipped(reason) if reason != "disabled" => {
            fields["skipped_post"] = json!(reason);
        }
        _ => {}
    }
    context.trace("action.artifacts", fields)
}

pub(crate) fn resolve_screenshot_path(trace_dir: &Path, relative: &str) -> Option<PathBuf> {
    if relative.is_empty() || relative.starts_with('/') || relative.contains('\\') {
        return None;
    }
    let path = PathBuf::from(relative);
    for component in path.components() {
        if matches!(
            component,
            Component::ParentDir | Component::RootDir | Component::Prefix(_)
        ) {
            return None;
        }
    }
    let joined = trace_dir.join(&path);
    let canonical = joined.canonicalize().ok()?;
    let trace_canonical = trace_dir.canonicalize().ok()?;
    if !canonical.starts_with(&trace_canonical) {
        return None;
    }
    if is_symlink(&joined) {
        return None;
    }
    Some(joined)
}

pub(crate) fn read_screenshot_for_embed(trace_dir: &Path, relative: &str) -> Option<Vec<u8>> {
    let path = resolve_screenshot_path(trace_dir, relative)?;
    crate::storage::private_file::read_private_bounded(&path, MAX_EMBED_SCREENSHOT_BYTES).ok()
}

#[cfg(test)]
#[path = "trace_artifacts_tests.rs"]
mod tests;

#[cfg(test)]
#[path = "trace_artifacts_more_tests.rs"]
mod more_tests;

#[cfg(test)]
#[path = "trace_artifacts_toctou_tests.rs"]
mod toctou_tests;

#[cfg(test)]
#[path = "trace_artifacts_dispatch_budget_tests.rs"]
mod dispatch_budget_tests;
