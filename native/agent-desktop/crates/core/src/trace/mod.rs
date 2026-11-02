use self::trace_write_budget::TraceWriteBudget;
use crate::AppError;
use crate::trace::trace_file::{open_segment_trace_file, open_trace_file};
use crate::trace::trace_sanitize::sanitize_trace_value;
use crate::trace::trace_state::{TracePending, TraceState, TraceWriterState};
use serde_json::{Map, Value, json};
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};

#[cfg(test)]
use crate::trace::trace_file::segment_path_for_dir;
pub(crate) use crate::trace::trace_file::{ensure_trace_dir, process_start_ms};

pub(crate) const MAX_TRACE_FILE_BYTES: u64 = 64 * 1024 * 1024;
const MAX_TRACE_EVENT_BYTES: usize = 1024 * 1024;
static EVENT_SEQ: AtomicU64 = AtomicU64::new(0);

#[derive(Debug, Clone, Default)]
pub struct TraceConfig {
    strict: bool,
    state: Arc<TraceState>,
}

impl TraceConfig {
    pub fn build(
        explicit_path: Option<PathBuf>,
        session_segment_dir: Option<PathBuf>,
        strict: bool,
    ) -> Result<Self, AppError> {
        if strict && explicit_path.is_none() && session_segment_dir.is_none() {
            return Err(AppError::invalid_input_with_suggestion(
                "--trace-strict requires --trace or an active trace-enabled session",
                "Provide --trace <path>, start a session with tracing, or remove --trace-strict.",
            ));
        }
        let (pending, writer) = match explicit_path {
            Some(path) => match open_trace_file(&path) {
                Ok(file) => (
                    TracePending::File(path),
                    TraceWriterState::Open(Arc::new(Mutex::new(file))),
                ),
                Err(err) if strict || err.code() == "INVALID_ARGS" => return Err(err),
                Err(err) => {
                    tracing::warn!("trace open failed: {err}");
                    (TracePending::File(path), TraceWriterState::Failed)
                }
            },
            None => match session_segment_dir {
                Some(dir) => (TracePending::SegmentDir(dir), TraceWriterState::Unopened),
                None => (TracePending::None, TraceWriterState::Unopened),
            },
        };
        Ok(Self {
            strict,
            state: Arc::new(TraceState {
                pending,
                emission: Mutex::new(()),
                writer: Arc::new(Mutex::new(writer)),
                meta_written: AtomicBool::new(false),
            }),
        })
    }

    pub fn emit(
        &self,
        event: &str,
        session_id: Option<&str>,
        fields: Value,
    ) -> Result<(), AppError> {
        self.emit_lazy(event, session_id, || fields)
    }

    pub fn emit_lazy(
        &self,
        event: &str,
        session_id: Option<&str>,
        fields: impl FnOnce() -> Value,
    ) -> Result<(), AppError> {
        let _emission = self
            .state
            .emission
            .lock()
            .map_err(|_| AppError::Internal("trace emission lock poisoned".into()))?;
        let mut budget = match &self.state.pending {
            TracePending::SegmentDir(dir) => match TraceWriteBudget::acquire(dir) {
                Ok(budget) => Some(budget),
                Err(error) if self.strict => return Err(error),
                Err(error) => {
                    tracing::warn!("trace recording limit unavailable: {error}");
                    return Ok(());
                }
            },
            _ => None,
        };
        let writer = match self.ensure_writer()? {
            Some(writer) => writer,
            None => return Ok(()),
        };
        match writer
            .lock()
            .map_err(|_| AppError::Internal("trace writer lock poisoned".into()))
            .and_then(|mut file| {
                with_exclusive_file(&mut file, |file| {
                    self.ensure_meta_if_needed(file, session_id, budget.as_mut())?;
                    write_event_locked(file, event, session_id, fields(), budget.as_mut())
                })
            }) {
            Ok(()) => Ok(()),
            Err(err) if self.strict => Err(err),
            Err(err) => {
                tracing::warn!("trace write failed: {err}");
                Ok(())
            }
        }
    }

    fn ensure_writer(&self) -> Result<Option<Arc<Mutex<std::fs::File>>>, AppError> {
        let mut writer = self
            .state
            .writer
            .lock()
            .map_err(|_| AppError::Internal("trace writer lock poisoned".into()))?;
        match &*writer {
            TraceWriterState::Open(file) => return Ok(Some(file.clone())),
            TraceWriterState::Failed => return Ok(None),
            TraceWriterState::Unopened => {}
        }
        let open_result = match &self.state.pending {
            TracePending::None => {
                *writer = TraceWriterState::Failed;
                return Ok(None);
            }
            TracePending::File(path) => open_trace_file(path),
            TracePending::SegmentDir(dir) => open_segment_trace_file(dir),
        };
        match open_result {
            Ok(file) => {
                let file = Arc::new(Mutex::new(file));
                *writer = TraceWriterState::Open(file.clone());
                Ok(Some(file))
            }
            Err(err) if self.strict => Err(err),
            Err(err) if err.code() == "INVALID_ARGS" => Err(err),
            Err(err) => {
                tracing::warn!("trace open failed: {err}");
                *writer = TraceWriterState::Failed;
                Ok(None)
            }
        }
    }

    pub(crate) fn has_sink(&self) -> bool {
        if matches!(self.state.pending, TracePending::None) {
            return false;
        }
        match self.state.writer.lock() {
            Ok(writer) => !matches!(*writer, TraceWriterState::Failed),
            Err(_) => true,
        }
    }

    pub(crate) fn pending_file_path(&self) -> Option<&Path> {
        match &self.state.pending {
            TracePending::File(path) => Some(path),
            _ => None,
        }
    }

    pub(crate) fn clone_with_session_segment(
        &self,
        session_segment_dir: Option<PathBuf>,
    ) -> Result<Self, AppError> {
        if self.pending_file_path().is_some() && self.has_sink() {
            return Ok(self.clone());
        }
        match session_segment_dir {
            Some(dir) => Self::build(None, Some(dir), self.strict),
            None => Ok(Self {
                strict: self.strict,
                state: Arc::new(TraceState::default()),
            }),
        }
    }

    fn ensure_meta_if_needed(
        &self,
        file: &mut std::fs::File,
        session_id: Option<&str>,
        budget: Option<&mut TraceWriteBudget>,
    ) -> Result<(), AppError> {
        if self.state.meta_written.load(Ordering::Relaxed) {
            return Ok(());
        }
        if file.metadata()?.len() > 0 {
            self.state.meta_written.store(true, Ordering::Relaxed);
            return Ok(());
        }
        write_meta_header_locked(file, session_id, budget)?;
        self.state.meta_written.store(true, Ordering::Relaxed);
        Ok(())
    }
}

fn write_meta_header_locked(
    file: &mut std::fs::File,
    session_id: Option<&str>,
    budget: Option<&mut TraceWriteBudget>,
) -> Result<(), AppError> {
    write_event_locked(
        file,
        "trace.meta",
        session_id,
        json!({
            "schema": 1,
            "version": env!("CARGO_PKG_VERSION"),
            "os": std::env::consts::OS,
            "pid": std::process::id(),
            "proc_start_ms": process_start_ms(),
        }),
        budget,
    )
}

#[cfg(test)]
fn write_event(
    file: &mut std::fs::File,
    event: &str,
    session_id: Option<&str>,
    fields: Value,
) -> Result<(), AppError> {
    with_exclusive_file(file, |file| {
        write_event_locked(file, event, session_id, fields, None)
    })
}

fn write_event_locked(
    file: &mut std::fs::File,
    event: &str,
    session_id: Option<&str>,
    fields: Value,
    budget: Option<&mut TraceWriteBudget>,
) -> Result<(), AppError> {
    let envelope_bytes = event
        .len()
        .saturating_mul(6)
        .saturating_add(session_id.map_or(0, |session| session.len().saturating_mul(6)))
        .saturating_add(512);
    if envelope_bytes >= MAX_TRACE_EVENT_BYTES
        || !value_fits(&fields, MAX_TRACE_EVENT_BYTES - envelope_bytes)
    {
        return Err(AppError::invalid_input_with_suggestion(
            "Trace event exceeds the maximum supported event size",
            "Emit bounded metadata and omit raw application content from trace fields.",
        ));
    }
    let mut body = match sanitize_trace_value(fields) {
        Value::Object(fields) => fields,
        _ => Map::new(),
    };
    body.insert("event".to_string(), json!(event));
    body.insert(
        "ts_ms".to_string(),
        json!(
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map_err(|err| AppError::Internal(err.to_string()))?
                .as_millis()
        ),
    );
    body.insert(
        "seq".to_string(),
        json!(EVENT_SEQ.fetch_add(1, Ordering::Relaxed)),
    );
    body.insert("writer_pid".to_string(), json!(std::process::id()));
    body.insert(
        "writer_proc_start_ms".to_string(),
        json!(process_start_ms()),
    );
    if let Some(sid) = session_id {
        body.insert("session_id".to_string(), json!(sid));
    }
    let mut line = Vec::new();
    serde_json::to_writer(&mut line, &Value::Object(body))?;
    line.push(b'\n');
    reject_oversized_trace(file, line.len() as u64)?;
    if let Some(budget) = budget {
        budget.reserve_line(line.len())?;
    }
    file.write_all(&line).map_err(AppError::from)
}

fn value_fits(value: &Value, max_bytes: usize) -> bool {
    fn visit(value: &Value, remaining: &mut usize) -> bool {
        let fixed = match value {
            Value::Null => 4,
            Value::Bool(_) => 5,
            Value::Number(_) => 32,
            Value::String(string) => string.len().saturating_mul(6),
            Value::Array(values) => {
                if !take(remaining, values.len()) {
                    return false;
                }
                return values.iter().all(|value| visit(value, remaining));
            }
            Value::Object(values) => {
                for (key, value) in values {
                    if !take(remaining, key.len().saturating_mul(6).saturating_add(4))
                        || !visit(value, remaining)
                    {
                        return false;
                    }
                }
                return true;
            }
        };
        take(remaining, fixed)
    }

    fn take(remaining: &mut usize, amount: usize) -> bool {
        let Some(next) = remaining.checked_sub(amount) else {
            return false;
        };
        *remaining = next;
        true
    }

    let mut remaining = max_bytes;
    visit(value, &mut remaining)
}

fn reject_oversized_trace(file: &std::fs::File, incoming: u64) -> Result<(), AppError> {
    let len = file.metadata()?.len();
    if len.saturating_add(incoming) <= MAX_TRACE_FILE_BYTES {
        return Ok(());
    }
    Err(AppError::invalid_input_with_suggestion(
        "Trace file reached the maximum supported size",
        "Start a new --trace file or rotate the existing trace before retrying.",
    ))
}

fn with_exclusive_file<T>(
    file: &mut std::fs::File,
    operation: impl FnOnce(&mut std::fs::File) -> Result<T, AppError>,
) -> Result<T, AppError> {
    file.lock().map_err(AppError::from)?;
    let result = operation(file);
    let unlock = file.unlock().map_err(AppError::from);
    match result {
        Ok(value) => {
            unlock?;
            Ok(value)
        }
        Err(error) => Err(error),
    }
}

#[cfg(test)]
#[path = "trace_tests.rs"]
mod tests;
pub(crate) mod trace_artifact_budget;
pub(crate) mod trace_artifacts;
pub(crate) mod trace_file;
pub mod trace_read;
pub mod trace_sanitize;
pub(crate) mod trace_state;

pub(crate) mod trace_write_budget;
