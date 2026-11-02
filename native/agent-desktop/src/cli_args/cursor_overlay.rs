use clap::Args;

use super::cursor_overlay_action::CursorOverlayAction;

#[derive(Args, Debug)]
pub(crate) struct CursorOverlayArgs {
    #[command(subcommand)]
    pub action: CursorOverlayAction,
}
