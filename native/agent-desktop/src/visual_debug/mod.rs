mod capture;
pub(crate) mod options;
mod render;

use std::fs::{File, OpenOptions};
use std::io::Write;
use std::path::PathBuf;

use agent_desktop_core::{
    AppError, Deadline, PlatformAdapter, WindowInfo, context::CommandContext,
};
use serde_json::{Value, json};

use crate::cli::Commands;
use options::DebugOptions;

pub(crate) struct DebugCapture {
    file: File,
    path: PathBuf,
    before: Option<Value>,
    window: Option<WindowInfo>,
    strip_bounds: bool,
    mode: &'static str,
}

impl DebugCapture {
    pub(crate) fn prepare(
        command: &mut Commands,
        options: &DebugOptions,
        adapter: &dyn PlatformAdapter,
        context: &CommandContext,
    ) -> Result<Option<Self>, AppError> {
        options.validate(command)?;
        let Some(path) = options.screenshot.as_ref() else {
            return Ok(None);
        };
        let (before, window, strip_bounds, mode) = match command {
            Commands::Click(args) => {
                let (window, before) = capture::click_before(args, adapter, context)?;
                (Some(before), Some(window), false, "click")
            }
            Commands::Snapshot(args) => {
                let strip = !args.tree.include_bounds;
                args.tree.include_bounds = true;
                let mode = if args.root.is_some() {
                    "drill-down"
                } else if args.tree.skeleton {
                    "skeleton"
                } else {
                    "snapshot"
                };
                (None, None, strip, mode)
            }
            _ => return Err(AppError::invalid_input("Unsupported debug command")),
        };
        let mut open = OpenOptions::new();
        open.write(true).create_new(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            open.mode(0o600);
        }
        let file = open.open(path).map_err(|error| AppError::invalid_input(format!(
            "Cannot create debug output '{}': {error}. Choose a new .html path in an existing directory.", path.display()
        )))?;
        Ok(Some(Self {
            file,
            path: path.clone(),
            before,
            window,
            strip_bounds,
            mode,
        }))
    }

    pub(crate) fn finish(
        mut self,
        result: &mut Result<Value, AppError>,
        adapter: &dyn PlatformAdapter,
        context: &CommandContext,
    ) {
        let mut artifact = json!({
            "mode": self.mode,
            "ok": result.is_ok(),
            "notice": "Local debug artifact: contains sensitive screenshots and accessibility labels. Captures are sequential observations, not a recording or proof of click delivery."
        });
        if let Some(before) = self.before.take() {
            artifact["before"] = before;
        }
        let captured = if let Some(window) = self.window.as_ref() {
            Deadline::standard()
                .map_err(AppError::from)
                .and_then(|deadline| capture::capture_frame(window, adapter, deadline))
        } else if let Ok(data) = result.as_ref() {
            capture::snapshot_frame(data, adapter, context)
        } else {
            Err(AppError::invalid_input(
                "Command failed before a snapshot was available",
            ))
        };
        let warning = match captured {
            Ok(frame) => {
                artifact["after"] = frame;
                None
            }
            Err(error) => {
                let warning = error.to_string();
                artifact["warning"] = json!(warning);
                Some(warning)
            }
        };
        match result.as_ref() {
            Ok(data) => {
                if self.mode == "click" {
                    artifact["result"] = data.clone();
                }
                if let Some(id) = data.get("snapshot_id") {
                    artifact["snapshot_id"] = id.clone();
                }
            }
            Err(error) => {
                artifact["error"] =
                    serde_json::to_value(agent_desktop_core::ErrorPayload::from_app_error(error))
                        .unwrap_or_else(|_| json!({"message": error.to_string()}))
            }
        }
        let write_result = render::html(&artifact).and_then(|html| {
            self.file.write_all(html.as_bytes())?;
            self.file.flush()?;
            Ok(())
        });
        let metadata = match write_result {
            Ok(()) => {
                let mut value = json!({"path": self.path, "format": "html"});
                if let Some(warning) = warning {
                    value["warning"] = json!(warning);
                }
                value
            }
            Err(error) => json!({"warning": format!("Debug artifact write failed: {error}")}),
        };
        if let Ok(data) = result {
            if self.strip_bounds
                && let Some(tree) = data.get_mut("tree")
            {
                strip_bounds(tree);
            }
            data["debug"] = metadata;
        } else {
            eprintln!("agent-desktop debug: {metadata}");
        }
    }
}

fn strip_bounds(node: &mut Value) {
    if let Some(object) = node.as_object_mut() {
        object.remove("bounds");
        if let Some(children) = object.get_mut("children").and_then(Value::as_array_mut) {
            for child in children {
                strip_bounds(child);
            }
        }
    }
}

#[cfg(test)]
mod tests;
