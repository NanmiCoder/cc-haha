use crate::{
    AppError, ClipboardContent, ClipboardFormat, ImageBuffer,
    adapter::PlatformAdapter,
    context::CommandContext,
    refs::refs_store::{
        STALE_TMP_MAX_AGE,
        prune::{is_orphaned_tmp_file, remove_stale_files_in_dir},
    },
    refs::{write_private_file, write_user_file},
    session,
};
use serde_json::{Value, json};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

pub struct ClipboardGetArgs {
    pub format: Option<ClipboardFormat>,
    pub out: Option<PathBuf>,
}

static IMAGE_TEMP_COUNTER: AtomicU64 = AtomicU64::new(0);

const CLIPBOARD_IMAGE_MAX_AGE: Duration = Duration::from_secs(60 * 60);

pub fn execute(
    args: ClipboardGetArgs,
    adapter: &dyn PlatformAdapter,
    context: &CommandContext,
) -> Result<Value, AppError> {
    let format = args.format.unwrap_or(ClipboardFormat::Text);
    let Some(content) = adapter.get_clipboard_content(format, crate::Deadline::standard()?)? else {
        return Ok(json!({ "type": format.as_str(), "found": false }));
    };
    match content {
        ClipboardContent::Text(text) => Ok(json!({ "type": "text", "text": text })),
        ClipboardContent::FileUrls(file_urls) => {
            Ok(json!({ "type": "file_urls", "file_urls": file_urls }))
        }
        ClipboardContent::Image(image) => write_image(image, args.out, context),
    }
}

fn write_image(
    image: ImageBuffer,
    out: Option<PathBuf>,
    context: &CommandContext,
) -> Result<Value, AppError> {
    let path = match out {
        Some(path) => {
            write_user_file(&path, &image.data).map_err(|error| {
                crate::refs::unwritable_output("the clipboard content", &path, error)
            })?;
            path
        }
        None => {
            let path = default_clipboard_image_path(context)?;
            write_private_file(&path, &image.data)?;
            path
        }
    };
    Ok(json!({
        "type": "image",
        "path": path.to_string_lossy(),
        "width": image.width,
        "height": image.height,
    }))
}

fn default_clipboard_image_path(context: &CommandContext) -> Result<PathBuf, AppError> {
    let dir = match context.session_id() {
        Some(id) => session::session_dir(id)?.join("clipboard"),
        None => {
            let dir = session::agent_desktop_dir()?.join("tmp");
            prune_sessionless_clipboard_tmp_dir(&dir);
            dir
        }
    };
    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or(0);
    let seq = IMAGE_TEMP_COUNTER.fetch_add(1, Ordering::Relaxed);
    Ok(dir.join(format!(
        "clipboard-{}-{nanos}-{seq}.png",
        std::process::id()
    )))
}

fn prune_sessionless_clipboard_tmp_dir(dir: &Path) {
    remove_stale_files_in_dir(dir, STALE_TMP_MAX_AGE, is_orphaned_tmp_file);
    remove_stale_files_in_dir(dir, CLIPBOARD_IMAGE_MAX_AGE, is_clipboard_image_file);
}

fn is_clipboard_image_file(path: &Path) -> bool {
    path.file_name()
        .and_then(|name| name.to_str())
        .is_some_and(|name| name.starts_with("clipboard-") && name.ends_with(".png"))
}

#[cfg(test)]
#[path = "clipboard_get_tests.rs"]
mod tests;
