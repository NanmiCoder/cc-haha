use clap::Subcommand;

use super::cursor_overlay_enable::CursorOverlayEnableArgs;

#[derive(Subcommand, Debug)]
pub(crate) enum CursorOverlayAction {
    #[command(about = "Enable and configure the cursor overlay for the selected session")]
    Enable(Box<CursorOverlayEnableArgs>),
    #[command(about = "Disable the cursor overlay for the selected session")]
    Disable,
}
