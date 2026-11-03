use crate::{
    AppError,
    adapter::{PlatformAdapter, SnapshotSurface},
    context::CommandContext,
};
use serde_json::{Value, json};

pub struct OpenSystemSurfaceArgs {
    pub surface: SnapshotSurface,
}

/// Opens a shell surface and answers with the identity of the window the
/// surface actually presents: the same `w-<hwnd>` identity the observation
/// stack roots, so `snapshot --surface <kind>` consumes it with no second
/// lookup. The answer comes from the adapter's kind
/// table, never from `supported_surfaces()`: that list says which kinds a
/// snapshot can root, while opening depends on what the running build
/// exposes - knowledge only the adapter has. Routing through the supported
/// set would refuse a build-conditional kind with a bare "not supported"
/// carrying neither the build nor the alternative, and would make the
/// adapter's own informative refusal unreachable.
///
/// The interaction policy travels explicitly because the floor that refuses
/// a caller whose policy forbids the foreground to move is enforced by the
/// adapter, before the surface is raised; the lease is taken here, the same
/// way every command that moves the desktop takes it.
pub fn execute(
    args: OpenSystemSurfaceArgs,
    adapter: &dyn PlatformAdapter,
    context: &CommandContext,
) -> Result<Value, AppError> {
    let deadline = crate::Deadline::standard()?;
    let policy = context.physical_input_policy();
    let lease = adapter.acquire_interaction_lease(deadline)?;
    let window = adapter.open_system_surface(args.surface, policy, &lease)?;
    Ok(json!({
        "surface": args.surface.as_str(),
        "window": window,
    }))
}

#[cfg(test)]
#[path = "open_system_surface_tests.rs"]
mod tests;
