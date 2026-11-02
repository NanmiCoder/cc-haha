use super::{ReadOptions, empty_trace_dir_error};
use crate::AppError;
use crate::trace::trace_artifacts::read_screenshot_for_embed;
use base64::Engine;
use serde_json::{Value, json};
use std::collections::HashSet;
use std::path::{Path, PathBuf};
#[cfg(test)]
use std::sync::atomic::{AtomicU64, Ordering};

const VIEWER_HTML: &str = include_str!("viewer.html");
const VIEWER_CSS: &str = include_str!("viewer.css");
const VIEWER_JS: &str = include_str!("viewer.js");

pub const TRACE_EXPORT_DEFAULT_LIMIT: usize = 5000;
const MAX_EMBED_SCREENSHOT_BYTES: u64 = 100 * 1024 * 1024;
const MAX_JSON_BYTES: u64 = 200 * 1024 * 1024;

#[cfg(test)]
static TEST_MAX_JSON_BYTES: AtomicU64 = AtomicU64::new(0);

#[cfg(test)]
pub(crate) fn set_test_max_json_bytes(limit: u64) {
    TEST_MAX_JSON_BYTES.store(limit, Ordering::Relaxed);
}

#[cfg(test)]
pub(crate) fn clear_test_max_json_bytes() {
    TEST_MAX_JSON_BYTES.store(0, Ordering::Relaxed);
}

fn max_json_bytes() -> u64 {
    #[cfg(test)]
    {
        let limit = TEST_MAX_JSON_BYTES.load(Ordering::Relaxed);
        if limit > 0 {
            return limit;
        }
    }
    MAX_JSON_BYTES
}

#[derive(Debug, Clone)]
pub struct ExportOptions {
    pub limit: usize,
    pub out: Option<PathBuf>,
}

#[derive(Debug, Clone, serde::Serialize)]
pub struct ExportStats {
    pub path: String,
    pub event_count: usize,
    pub screenshots_embedded: usize,
    pub screenshots_skipped: usize,
    pub bytes: usize,
    pub warnings: Vec<Value>,
    pub truncated: bool,
    pub total_events: usize,
    pub returned_events: usize,
}

pub fn export_html(
    trace_dir: &Path,
    session_id: &str,
    options: &ExportOptions,
) -> Result<(String, ExportStats), AppError> {
    export_html_for_command(trace_dir, session_id, options, None)
}

pub(crate) fn export_html_for_command(
    trace_dir: &Path,
    session_id: &str,
    options: &ExportOptions,
    current_command: Option<(u32, u64, &str)>,
) -> Result<(String, ExportStats), AppError> {
    let merged = super::read_merged_for_command(
        trace_dir,
        &ReadOptions {
            limit: options.limit,
            event_prefix: None,
        },
        current_command,
    )?;
    if merged.segments.is_empty() {
        return Err(empty_trace_dir_error(session_id));
    }

    let (screenshots, embedded, skipped) = embed_screenshots(trace_dir, &merged.events)?;

    let island = json!({
        "session_id": session_id,
        "total_events": merged.total_events,
        "returned_events": merged.returned_events,
        "truncated": merged.truncated,
        "warnings": merged.warnings,
        "screenshots": screenshots,
        "screenshots_embedded": embedded,
        "screenshots_skipped": skipped,
        "events": merged.events,
    });

    let island_json = serde_json::to_string(&island)?;
    if island_json.len() as u64 > max_json_bytes() {
        return Err(AppError::invalid_input_with_suggestion(
            "Trace export exceeds the maximum embedded JSON size",
            "Re-run with a smaller --limit to embed fewer events.",
        ));
    }

    let escaped = escape_for_json_island(&island_json);
    let html = VIEWER_HTML
        .replace("{{CSS}}", VIEWER_CSS)
        .replace("{{JS}}", VIEWER_JS)
        .replace("{{DATA}}", &escaped);

    if html.len() as u64 > max_json_bytes() + (512 * 1024) {
        return Err(AppError::invalid_input_with_suggestion(
            "Trace export exceeds the maximum output size",
            "Re-run with a smaller --limit to embed fewer events.",
        ));
    }

    let path = options.out.clone().unwrap_or_else(|| {
        trace_dir
            .parent()
            .unwrap_or(trace_dir)
            .join(format!("trace-{session_id}.html"))
    });

    crate::refs::write_user_file(&path, html.as_bytes())
        .map_err(|error| crate::refs::unwritable_output("the trace export", &path, error))?;
    let bytes = html.len();

    let warnings: Vec<Value> = merged
        .warnings
        .iter()
        .map(serde_json::to_value)
        .collect::<Result<_, _>>()?;

    Ok((
        html,
        ExportStats {
            path: path.to_string_lossy().into_owned(),
            event_count: merged.returned_events,
            screenshots_embedded: embedded,
            screenshots_skipped: skipped,
            bytes,
            warnings,
            truncated: merged.truncated,
            total_events: merged.total_events,
            returned_events: merged.returned_events,
        },
    ))
}

fn embed_screenshots(
    trace_dir: &Path,
    events: &[Value],
) -> Result<(Value, usize, usize), AppError> {
    let mut paths: Vec<String> = Vec::new();
    let mut seen: HashSet<String> = HashSet::new();
    for event in events {
        if event.get("event").and_then(Value::as_str) != Some("action.artifacts") {
            continue;
        }
        for key in ["screenshot_pre", "screenshot_post"] {
            let Some(path) = event.get(key).and_then(Value::as_str) else {
                continue;
            };
            if seen.contains(path) {
                continue;
            }
            seen.insert(path.to_string());
            paths.push(path.to_string());
        }
    }

    let mut map = serde_json::Map::new();
    let mut embedded = 0usize;
    let mut skipped = 0usize;
    let mut used_bytes = 0u64;

    for rel in paths {
        let Some(bytes) = read_screenshot_for_embed(trace_dir, &rel) else {
            skipped += 1;
            continue;
        };
        let next = used_bytes.saturating_add(bytes.len() as u64);
        if next > MAX_EMBED_SCREENSHOT_BYTES {
            skipped += 1;
            continue;
        }
        used_bytes = next;
        let encoded = base64::engine::general_purpose::STANDARD.encode(bytes);
        map.insert(rel, json!(format!("data:image/png;base64,{encoded}")));
        embedded += 1;
    }

    Ok((Value::Object(map), embedded, skipped))
}

fn escape_for_json_island(json: &str) -> String {
    let mut out = String::with_capacity(json.len());
    for ch in json.chars() {
        match ch {
            '<' => out.push_str("\\u003c"),
            '>' => out.push_str("\\u003e"),
            '&' => out.push_str("\\u0026"),
            '\u{2028}' => out.push_str("\\u2028"),
            '\u{2029}' => out.push_str("\\u2029"),
            other => out.push(other),
        }
    }
    out
}

#[cfg(test)]
#[path = "html_tests.rs"]
mod tests;

#[cfg(test)]
#[path = "html_screenshot_tests.rs"]
mod screenshot_tests;

#[cfg(test)]
#[path = "html_export_stats_tests.rs"]
mod export_stats_tests;

#[cfg(test)]
#[path = "html_write_tests.rs"]
mod write_tests;
