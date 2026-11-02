use agent_desktop_core::{
    AppError, PlatformAdapter,
    commands::{clipboard_get, clipboard_set},
    context::CommandContext,
};
use serde_json::Value;

use crate::cli_args::system::{ClipboardGetArgs, ClipboardSetArgs};
use crate::dispatch::parse::parse_clipboard_format;

pub(super) fn get(
    args: ClipboardGetArgs,
    adapter: &dyn PlatformAdapter,
    context: &CommandContext,
) -> Result<Value, AppError> {
    clipboard_get::execute(
        clipboard_get::ClipboardGetArgs {
            format: args
                .format
                .as_deref()
                .map(parse_clipboard_format)
                .transpose()?,
            out: args.out,
        },
        adapter,
        context,
    )
}

pub(super) fn set(
    args: ClipboardSetArgs,
    adapter: &dyn PlatformAdapter,
) -> Result<Value, AppError> {
    clipboard_set::execute(
        clipboard_set::ClipboardSetArgs {
            text: args.text,
            image: args.image,
            file_urls: args.file_url,
        },
        adapter,
    )
}
