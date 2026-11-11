use crate::{AppError, SnapshotSurface};

/// A ref already carries the surface it was captured from, so naming a second
/// one asks for two roots at once.
pub(crate) fn reject_root_with_surface(
    command: &str,
    root: Option<&str>,
    surface: SnapshotSurface,
) -> Result<(), AppError> {
    if root.is_none() || matches!(surface, SnapshotSurface::Window) {
        return Ok(());
    }
    Err(AppError::invalid_input_with_suggestion(
        "--root cannot be combined with --surface",
        format!(
            "A ref is already scoped to its own surface. Run `{command} --surface` without \
             --root, or drop --surface."
        ),
    ))
}

#[cfg(test)]
#[path = "surface_scope_tests.rs"]
mod tests;
