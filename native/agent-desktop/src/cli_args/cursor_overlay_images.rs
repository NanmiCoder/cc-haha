use agent_desktop_core::{AppError, CursorImage, CursorOverlayStyle, Point};
use clap::Args;
use std::path::PathBuf;

#[derive(Args, Debug, Default)]
pub(crate) struct CursorOverlayImagesArgs {
    #[arg(
        long,
        value_name = "PATH",
        help = "Draw the cursor from a PNG file instead of the built-in arrow; scaled by --size"
    )]
    pub image: Option<PathBuf>,
    #[arg(
        long,
        value_name = "X,Y",
        requires = "image",
        value_parser = parse_hotspot,
        help = "Point in the image, in image points from its top-left, that marks the click position (default 0,0)"
    )]
    pub hotspot: Option<(f64, f64)>,
    #[arg(
        long,
        value_name = "PATH",
        help = "PNG shown instead while the cursor rests on a button, link or other pressable control"
    )]
    pub pointer_image: Option<PathBuf>,
    #[arg(
        long,
        value_name = "X,Y",
        requires = "pointer_image",
        value_parser = parse_hotspot,
        help = "Click point in the pointer image, in image points from its top-left (default 0,0)"
    )]
    pub pointer_hotspot: Option<(f64, f64)>,
}

impl CursorOverlayImagesArgs {
    pub(crate) fn apply_to(&self, style: &mut CursorOverlayStyle) -> Result<(), AppError> {
        style.set_image(cursor_image(self.image.as_deref(), self.hotspot)?);
        style.set_pointer_image(cursor_image(
            self.pointer_image.as_deref(),
            self.pointer_hotspot,
        )?);
        Ok(())
    }
}

fn cursor_image(
    path: Option<&std::path::Path>,
    hotspot: Option<(f64, f64)>,
) -> Result<Option<CursorImage>, AppError> {
    let Some(path) = path else {
        return Ok(None);
    };
    let resolved = std::fs::canonicalize(path).map_err(|error| {
        AppError::invalid_input(format!(
            "Cursor image '{}' cannot be read: {error}",
            path.display()
        ))
    })?;
    let resolved = resolved
        .into_os_string()
        .into_string()
        .map_err(|_| AppError::invalid_input("Cursor image path must be valid UTF-8"))?;
    let (x, y) = hotspot.unwrap_or((0.0, 0.0));
    let image = CursorImage::new(resolved, Point { x, y })?;
    image.verify_file()?;
    Ok(Some(image))
}

fn parse_hotspot(value: &str) -> Result<(f64, f64), String> {
    let invalid = || "hotspot must be X,Y in image points, e.g. 4,2".to_string();
    let (x, y) = value.split_once(',').ok_or_else(invalid)?;
    let x = x.trim().parse::<f64>().map_err(|_| invalid())?;
    let y = y.trim().parse::<f64>().map_err(|_| invalid())?;
    Ok((x, y))
}
