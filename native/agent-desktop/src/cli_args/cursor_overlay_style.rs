use agent_desktop_core::{AppError, CursorOverlayStyle};
use clap::Args;

#[derive(Args, Debug, Default)]
pub(crate) struct CursorOverlayStyleArgs {
    #[arg(
        long,
        conflicts_with = "image",
        help = "Cursor body colour as a hex value (default: the accent colour)"
    )]
    pub fill: Option<String>,
    #[arg(
        long,
        conflicts_with = "image",
        help = "Cursor outline colour as a hex value (default #111318)"
    )]
    pub rim: Option<String>,
    #[arg(
        long,
        help = "Cursor, ripple and element highlight colour as a hex value (default #4299FF)"
    )]
    pub accent: Option<String>,
    #[arg(long, help = "Cursor size multiplier from 0.5 to 4.0 (default 1.0)")]
    pub size: Option<f64>,
    #[arg(long, help = "Do not play the ripple when the agent clicks")]
    pub no_ripple: bool,
    #[arg(long, help = "Do not outline the element when the agent clicks")]
    pub no_highlight: bool,
    #[command(flatten)]
    pub images: super::cursor_overlay_images::CursorOverlayImagesArgs,
}

impl CursorOverlayStyleArgs {
    pub(crate) fn to_core(&self) -> Result<CursorOverlayStyle, AppError> {
        let mut style = CursorOverlayStyle::default();
        if let Some(fill) = self.fill.clone() {
            style.set_fill(fill);
        }
        if let Some(rim) = self.rim.clone() {
            style.set_rim(rim);
        }
        if let Some(accent) = self.accent.clone() {
            style.set_accent(accent);
        }
        if let Some(size) = self.size {
            style.set_size(size);
        }
        style.set_effects(!self.no_ripple, !self.no_highlight);
        self.images.apply_to(&mut style)?;
        Ok(style)
    }
}

#[cfg(test)]
#[path = "cursor_overlay_image_tests.rs"]
mod tests;
