use crate::AppError;
use crate::session::{
    ArtifactsMode, GcOptions, SessionTraceMode, StartSessionOptions, end_session, gc,
    list_sessions, start_session,
};
use serde_json::{Value, json};
use std::time::Duration;

#[derive(Debug, Clone)]
pub enum SessionAction {
    Start {
        name: Option<String>,
        no_trace: bool,
        screenshots: bool,
    },
    End {
        id: String,
    },
    List,
    Gc {
        older_than_secs: Option<u64>,
        ended_only: bool,
    },
}

pub fn execute(action: SessionAction) -> Result<Value, AppError> {
    match action {
        SessionAction::Start {
            name,
            no_trace,
            screenshots,
        } => {
            let manifest = start_session(StartSessionOptions {
                name,
                trace: if no_trace {
                    SessionTraceMode::Off
                } else {
                    SessionTraceMode::On
                },
                artifacts: if screenshots {
                    ArtifactsMode::Full
                } else {
                    ArtifactsMode::Events
                },
            })?;
            Ok(json!({
                "session_id": manifest.id,
                "name": manifest.name,
                "trace": manifest.trace,
                "artifacts": manifest.artifacts,
                "created_at": manifest.created_at,
                "next": activation_export(&manifest.id),
                "activation": activation(&manifest.id),
            }))
        }
        SessionAction::End { id } => {
            let manifest = end_session(&id)?;
            Ok(json!({
                "session_id": manifest.id,
                "ended_at": manifest.ended_at,
            }))
        }
        SessionAction::List => {
            let sessions: Vec<Value> = list_sessions()?
                .into_iter()
                .map(|manifest| {
                    json!({
                        "session_id": manifest.id,
                        "name": manifest.name,
                        "created_at": manifest.created_at,
                        "ended_at": manifest.ended_at,
                        "trace": manifest.trace,
                        "artifacts": manifest.artifacts,
                    })
                })
                .collect();
            Ok(json!({ "sessions": sessions }))
        }
        SessionAction::Gc {
            older_than_secs,
            ended_only,
        } => {
            let report = gc(GcOptions {
                ended_only,
                older_than: older_than_secs.map(Duration::from_secs),
            })?;
            Ok(json!({ "removed": report.removed }))
        }
    }
}

/// The line a caller pastes into their own shell, so the shell that matters
/// is the one running the command rather than the one this was built for.
/// Written as a runtime branch, not a compile-time one: core is built and
/// tested on every supported platform, and a conditionally-compiled arm is
/// only ever type-checked on the lane that selects it.
pub(super) fn activation_export(session_id: &str) -> String {
    if cfg!(windows) {
        format!("$env:AGENT_DESKTOP_SESSION = '{session_id}'")
    } else {
        format!("export AGENT_DESKTOP_SESSION={session_id}")
    }
}

pub(super) fn activation(session_id: &str) -> Value {
    json!({
        "environment": "AGENT_DESKTOP_SESSION",
        "value": session_id,
    })
}
