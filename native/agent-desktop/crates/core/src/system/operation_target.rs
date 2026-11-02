use serde::{Deserialize, Serialize};

use crate::{
    AdapterError, AppInfo, DeliverySemantics, ErrorCode, Point, ProcessIdentity, WindowInfo,
};

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum OperationTarget {
    Window {
        id: String,
        title: String,
        process: ProcessIdentity,
    },
    App {
        name: String,
        process: ProcessIdentity,
    },
    Pointer {
        point: Point,
    },
    Drag {
        from: Point,
        to: Point,
    },
    Clipboard,
}

impl OperationTarget {
    pub fn for_window(window: &WindowInfo) -> Result<Self, AdapterError> {
        let instance = require_instance(window.process_instance.as_deref(), "window")?;
        Ok(Self::Window {
            id: window.id.clone(),
            title: window.title.clone(),
            process: ProcessIdentity::new(window.pid, instance),
        })
    }

    pub(crate) fn window_without_instance(window: &WindowInfo) -> Self {
        Self::Window {
            id: window.id.clone(),
            title: window.title.clone(),
            process: ProcessIdentity::new(window.pid, ""),
        }
    }

    pub(crate) fn app_without_instance(app: &AppInfo) -> Self {
        Self::App {
            name: app.name.clone(),
            process: ProcessIdentity::new(app.pid, ""),
        }
    }

    pub fn for_app(app: &AppInfo) -> Result<Self, AdapterError> {
        let instance = require_instance(app.process_instance.as_deref(), "application")?;
        Ok(Self::App {
            name: app.name.clone(),
            process: ProcessIdentity::new(app.pid, instance),
        })
    }
}

fn require_instance(instance: Option<&str>, subject: &str) -> Result<String, AdapterError> {
    instance
        .filter(|instance| !instance.is_empty())
        .map(str::to_owned)
        .ok_or_else(|| {
            AdapterError::new(
                ErrorCode::Internal,
                format!("The {subject} has no process instance token to report as the target"),
            )
            .with_disposition(DeliverySemantics::not_delivered())
        })
}
