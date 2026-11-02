use super::budget::ReadBudget;
use crate::AppError;
use serde_json::Value;
use std::io::{BufRead, BufReader};
use std::path::Path;

pub(crate) const MAX_LINE_BYTES: usize = 8 * 1024 * 1024;
pub(crate) const KNOWN_SCHEMA_MAX: u32 = 1;

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct ParsedSegmentName {
    pub stem: String,
    pub pid: u32,
    pub proc_start_ms: u64,
}

#[derive(Debug, Clone)]
pub(crate) struct ParsedEvent {
    pub value: Value,
    pub ts_ms: u64,
    pub position: u64,
}

#[derive(Debug, Clone, Default)]
pub(crate) struct SegmentReadStats {
    pub event_count: usize,
    pub skipped_lines: usize,
    pub schema: u32,
    pub schema_warning: Option<String>,
    pub meta_seen: bool,
}

pub(crate) fn parse_segment_filename(name: &str) -> Option<ParsedSegmentName> {
    if !name.ends_with(".jsonl") {
        return None;
    }
    let stem = name.strip_suffix(".jsonl")?;
    if stem.ends_with(".tmp") {
        return None;
    }
    let (pid_str, ts_str) = stem.rsplit_once('-')?;
    if pid_str.is_empty() || ts_str.is_empty() {
        return None;
    }
    if !pid_str.chars().all(|c| c.is_ascii_digit()) {
        return None;
    }
    if !ts_str.chars().all(|c| c.is_ascii_digit()) {
        return None;
    }
    let pid: u32 = pid_str.parse().ok()?;
    let proc_start_ms: u64 = ts_str.parse().ok()?;
    Some(ParsedSegmentName {
        stem: stem.to_string(),
        pid,
        proc_start_ms,
    })
}

pub(super) fn read_segment_events(
    path: &Path,
    budget: &mut ReadBudget,
) -> Result<(Vec<ParsedEvent>, SegmentReadStats), AppError> {
    let file = crate::refs::open_nofollow(path).map_err(AppError::from)?;
    let mut reader = BufReader::new(file);
    let mut raw: Vec<u8> = Vec::new();
    let mut stats = SegmentReadStats::default();
    let mut events = Vec::new();
    let mut position: u64 = 0;

    loop {
        raw.clear();
        let bytes_read = read_bounded_line(&mut reader, &mut raw, budget)?;
        if bytes_read == 0 {
            break;
        }
        position += 1;
        let has_trailing_newline = raw.last() == Some(&b'\n');
        let line_bytes = if has_trailing_newline {
            &raw[..raw.len() - 1]
        } else {
            raw.as_slice()
        };

        if line_bytes.is_empty() {
            continue;
        }

        if line_bytes.len() > MAX_LINE_BYTES {
            stats.skipped_lines += 1;
            continue;
        }

        if !has_trailing_newline {
            stats.skipped_lines += 1;
            continue;
        }

        let Ok(line_body) = std::str::from_utf8(line_bytes) else {
            stats.skipped_lines += 1;
            continue;
        };

        let parsed: Value = match serde_json::from_str(line_body) {
            Ok(v) => v,
            Err(_) => {
                stats.skipped_lines += 1;
                continue;
            }
        };

        let Some(obj) = parsed.as_object() else {
            stats.skipped_lines += 1;
            continue;
        };

        if obj.get("event").and_then(Value::as_str) == Some("trace.meta") && !stats.meta_seen {
            stats.meta_seen = true;
            if let Some(schema) = obj.get("schema").and_then(Value::as_u64) {
                stats.schema = schema as u32;
                if stats.schema > KNOWN_SCHEMA_MAX {
                    stats.schema_warning = Some(format!(
                        "Segment schema {schema} exceeds reader maximum {KNOWN_SCHEMA_MAX}"
                    ));
                }
            }
        }

        let ts_ms = obj.get("ts_ms").and_then(Value::as_u64).unwrap_or(0);

        budget.consume_event()?;
        events.push(ParsedEvent {
            value: parsed,
            ts_ms,
            position,
        });
        stats.event_count += 1;
    }

    if !stats.meta_seen {
        stats.schema = 0;
    }

    Ok((events, stats))
}

fn read_bounded_line(
    reader: &mut impl BufRead,
    raw: &mut Vec<u8>,
    budget: &mut ReadBudget,
) -> Result<usize, AppError> {
    let mut total = 0;
    loop {
        let available = reader.fill_buf()?;
        if available.is_empty() {
            return Ok(total);
        }
        let newline = available.iter().position(|byte| *byte == b'\n');
        let consumed = newline.map_or(available.len(), |position| position + 1);
        budget.consume_bytes(consumed)?;
        let retained = consumed.min((MAX_LINE_BYTES + 2).saturating_sub(raw.len()));
        raw.extend_from_slice(&available[..retained]);
        total += consumed;
        reader.consume(consumed);
        if newline.is_some() {
            return Ok(total);
        }
    }
}
