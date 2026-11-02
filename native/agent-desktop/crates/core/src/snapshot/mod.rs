use crate::{
    AccessibilityNode, AppError, WindowInfo,
    adapter::{PlatformAdapter, TreeOptions, WindowFilter},
    context::CommandContext,
    locator::live_locator::{ObservationRequest, ObservationRoot},
    refs::RefMap,
    refs::ref_alloc::{self, RefAllocConfig},
    refs::ref_alloc_options::RefAllocOptions,
    refs::ref_alloc_scope::RefAllocScope,
    refs::ref_alloc_source::RefAllocSource,
    refs::refs_store::RefStore,
    trace::trace_artifacts,
};
use serde_json::json;

#[derive(Clone)]
pub struct SnapshotResult {
    pub tree: AccessibilityNode,
    pub refmap: RefMap,
    pub window: WindowInfo,
    pub snapshot_id: Option<String>,
    pub complete: bool,
    pub nodes_observed: usize,
}

impl SnapshotResult {
    pub(crate) fn bind_snapshot_id(&mut self, snapshot_id: String) {
        crate::refs::ref_token::qualify_tree_refs(&mut self.tree, &snapshot_id);
        self.snapshot_id = Some(snapshot_id);
    }
}

pub fn build(
    adapter: &dyn PlatformAdapter,
    opts: &TreeOptions,
    app_name: Option<&str>,
    window_id: Option<&str>,
    deadline: crate::Deadline,
) -> Result<SnapshotResult, AppError> {
    let windows = surface_windows(adapter, app_name, window_id, opts.surface, deadline)?;
    let observation_options = opts.with_ref_identity_bounds();
    let request = ObservationRequest::snapshot(&observation_options, deadline).validate()?;
    let (window, observed) = first_surface_owner(windows, |window| {
        crate::tree::renderer_accessibility::observe_tree(
            adapter,
            ObservationRoot::Window(window),
            &request,
        )
    })?;
    let (raw_tree, complete, nodes_observed) = observed.into_accessibility_tree_partial()?;

    let mut refmap = RefMap::new();
    let config = RefAllocConfig {
        options: RefAllocOptions {
            include_bounds: opts.include_bounds,
            interactive_only: opts.interactive_only,
            compact: opts.compact,
        },
        source: RefAllocSource {
            pid: window.pid,
            app: Some(window.app.as_str()),
            window_id: Some(window.id.as_str()),
            window_title: Some(window.title.as_str()),
            window_bounds_hash: window.bounds.as_ref().and_then(crate::Rect::bounds_hash),
            process_instance: window.process_instance.as_deref(),
            surface: opts.surface,
        },
        scope: RefAllocScope {
            root_ref_id: None,
            path_prefix: &[],
        },
    };
    let mut tree = ref_alloc::allocate_refs(raw_tree, &mut refmap, &config)?;

    crate::snapshot::hints::add_structural_hints(&mut tree);

    Ok(SnapshotResult {
        tree,
        refmap,
        window,
        snapshot_id: None,
        complete,
        nodes_observed,
    })
}

/// Resolves the window that identifies the process to observe. An app-level
/// surface is not owned by a single window, so several open windows must not be
/// reported as ambiguous when one is requested.
///
/// Kinds naming OS chrome rather than a window's own sub-surface are routed to
/// the adapter's `resolve_shell_surface` seam ahead of the application path,
/// because no application owns them and the window inventory cannot identify
/// them. An adapter that answers with the trait default falls through to the
/// application path, so an adapter's shape never changes by upgrading; every
/// other answer - a missing surface, a build refusal, a timeout - is returned
/// as the adapter supplied it.
pub(crate) fn resolve_window_for_surface(
    adapter: &dyn PlatformAdapter,
    app_name: Option<&str>,
    window_id: Option<&str>,
    surface: crate::SnapshotSurface,
    deadline: crate::Deadline,
) -> Result<WindowInfo, AppError> {
    if window_id.is_some() || matches!(surface, crate::SnapshotSurface::Window) {
        return resolve_window(adapter, app_name, window_id, deadline);
    }
    if is_shell_surface(surface) {
        match adapter.resolve_shell_surface(surface, deadline) {
            Ok(window) => return Ok(window),
            Err(error) if !error.is_default_not_supported("resolve_shell_surface") => {
                return Err(error.into());
            }
            Err(_) => {}
        }
    }
    crate::system::window_lookup::select_surface_owner(
        windows_for_app(adapter, app_name, deadline)?,
        crate::AdapterError::new(
            crate::ErrorCode::WindowNotFound,
            format!(
                "No window found to identify the application owning surface '{}'",
                surface.as_str()
            ),
        ),
    )
}

/// Whether the surface names OS chrome rather than a window's own sub-surface:
/// the kinds an adapter may resolve directly, with no owning application and
/// no window in the inventory. Derived from the [`SnapshotSurface`] variant
/// alone - never from a platform check - so the seam stays platform-neutral.
fn is_shell_surface(surface: crate::SnapshotSurface) -> bool {
    matches!(
        surface,
        crate::SnapshotSurface::StartMenu
            | crate::SnapshotSurface::Taskbar
            | crate::SnapshotSurface::SystemTray
            | crate::SnapshotSurface::SystemTrayOverflow
            | crate::SnapshotSurface::ActionCenter
            | crate::SnapshotSurface::QuickSettings
    )
}

pub(crate) fn surface_windows(
    adapter: &dyn PlatformAdapter,
    app_name: Option<&str>,
    window_id: Option<&str>,
    surface: crate::SnapshotSurface,
    deadline: crate::Deadline,
) -> Result<Vec<WindowInfo>, AppError> {
    use crate::SnapshotSurface::{Alert, Popover, Sheet};
    if window_id.is_none() && matches!(surface, Sheet | Popover | Alert) {
        let mut windows = match app_name {
            Some(_) => windows_for_app(adapter, app_name, deadline)?,
            None => frontmost_process_windows(adapter, surface, deadline)?,
        };
        windows.retain(|window| window.state.accessible);
        let windows = crate::system::window_lookup::surface_owner_order(windows);
        if !windows.is_empty() {
            return Ok(windows);
        }
    }
    Ok(vec![resolve_window_for_surface(
        adapter, app_name, window_id, surface, deadline,
    )?])
}

fn frontmost_process_windows(
    adapter: &dyn PlatformAdapter,
    surface: crate::SnapshotSurface,
    deadline: crate::Deadline,
) -> Result<Vec<WindowInfo>, AppError> {
    let owner = resolve_window_for_surface(adapter, None, None, surface, deadline)?;
    let mut windows = windows_for_app(adapter, Some(owner.app.as_str()), deadline)?;
    windows.retain(|window| window.pid == owner.pid);
    if windows.is_empty() {
        windows.push(owner);
    }
    Ok(windows)
}

pub(crate) fn first_surface_owner<T>(
    windows: Vec<WindowInfo>,
    mut observe: impl FnMut(&WindowInfo) -> Result<T, AppError>,
) -> Result<(WindowInfo, T), AppError> {
    let mut windows = windows.into_iter().peekable();
    while let Some(window) = windows.next() {
        match observe(&window) {
            Err(AppError::Adapter(error))
                if error.code == crate::ErrorCode::ElementNotFound && windows.peek().is_some() => {}
            result => return result.map(|observed| (window, observed)),
        }
    }
    Err(
        crate::AdapterError::new(crate::ErrorCode::WindowNotFound, "No window to observe")
            .unsent()
            .into(),
    )
}

fn windows_for_app(
    adapter: &dyn PlatformAdapter,
    app_name: Option<&str>,
    deadline: crate::Deadline,
) -> Result<Vec<WindowInfo>, AppError> {
    let filter = WindowFilter {
        focused_only: app_name.is_none(),
        app: app_name.map(str::to_string),
    };
    Ok(adapter.list_windows(&filter, deadline)?)
}

pub(crate) fn resolve_window(
    adapter: &dyn PlatformAdapter,
    app_name: Option<&str>,
    window_id: Option<&str>,
    deadline: crate::Deadline,
) -> Result<WindowInfo, AppError> {
    let filter = WindowFilter {
        focused_only: app_name.is_none() && window_id.is_none(),
        app: app_name.map(str::to_string),
    };

    let windows = adapter.list_windows(&filter, deadline)?;

    if let Some(wid) = window_id {
        windows.into_iter().find(|w| w.id == wid).ok_or_else(|| {
            AppError::Adapter(
                crate::AdapterError::new(
                    crate::ErrorCode::WindowNotFound,
                    format!("No window with id {wid}"),
                )
                .with_suggestion("Run 'list-windows' to see available window IDs.")
                .unsent(),
            )
        })
    } else if let Some(app) = app_name {
        if windows.is_empty() {
            if let Err(AppError::Adapter(error)) =
                crate::system::app_lookup::resolve_app(Some(app), adapter, deadline)
            {
                if error.code == crate::ErrorCode::AppNotFound {
                    return Err(AppError::Adapter(error));
                }
            }
        }
        crate::system::window_lookup::select_window(
            windows,
            crate::AdapterError::new(
                crate::ErrorCode::WindowNotFound,
                format!("Application '{app}' is running but has no matching window"),
            )
            .with_suggestion("Wait for the app to present a window, or run 'list-windows --app'."),
            "More than one window matches the target",
        )
    } else {
        crate::system::window_lookup::select_window(
            windows,
            crate::AdapterError::new(crate::ErrorCode::WindowNotFound, "No focused window found"),
            "More than one window matches the target",
        )
    }
}

#[cfg(test)]
pub fn run(
    adapter: &dyn PlatformAdapter,
    opts: &TreeOptions,
    app_name: Option<&str>,
    window_id: Option<&str>,
) -> Result<SnapshotResult, AppError> {
    run_with_context(
        adapter,
        opts,
        &SnapshotTarget {
            app_name,
            window_id,
        },
        &CommandContext::default(),
        DEFAULT_SNAPSHOT_TIMEOUT_MS,
    )
}

/// Which window a full snapshot targets: the focused window when both fields
/// are `None`, a named app's focused window, or an exact window id.
pub struct SnapshotTarget<'a> {
    pub app_name: Option<&'a str>,
    pub window_id: Option<&'a str>,
}

/// The default snapshot observation deadline.
///
/// A16-11 measured a cold Chromium settle at 10-25 s against the previous
/// hardcoded 3 s, so callers can raise it explicitly via `--timeout-ms`; the
/// default stays 3 s for the ecosystems that settle fast.
pub const DEFAULT_SNAPSHOT_TIMEOUT_MS: u64 = 3_000;

/// Runs a full snapshot for `target` and persists its refmap under
/// `context`'s session, using `timeout_ms` as the observation deadline
/// (`DEFAULT_SNAPSHOT_TIMEOUT_MS` for callers with no reason to raise it).
pub fn run_with_context(
    adapter: &dyn PlatformAdapter,
    opts: &TreeOptions,
    target: &SnapshotTarget,
    context: &CommandContext,
    timeout_ms: u64,
) -> Result<SnapshotResult, AppError> {
    let mut result = build(
        adapter,
        opts,
        target.app_name,
        target.window_id,
        crate::Deadline::after(timeout_ms)?,
    )?;
    let store = RefStore::for_session(context.session_id())?;
    let snapshot_id = store.save_new_snapshot(&result.refmap)?;
    trace_artifacts::copy_refmap_if_full(context, &store, &snapshot_id, &result.refmap)?;
    result.bind_snapshot_id(snapshot_id);
    emit_snapshot_saved(context, &result)?;
    Ok(result)
}

pub(crate) fn emit_snapshot_saved(
    context: &CommandContext,
    result: &SnapshotResult,
) -> Result<(), AppError> {
    context.trace_lazy("snapshot.saved", || {
        let mut fields = json!({
            "snapshot_id": result.snapshot_id,
            "ref_count": result.refmap.len(),
        });
        if !result.window.app.is_empty() {
            fields["app"] = json!(result.window.app);
        }
        fields
    })
}

pub mod hints;
pub mod snapshot_ref;
pub mod snapshot_surface;
#[cfg(test)]
#[path = "snapshot_tests.rs"]
mod tests;

#[cfg(test)]
#[path = "snapshot_window_tests.rs"]
mod window_tests;

#[cfg(test)]
#[path = "snapshot_surface_window_tests.rs"]
mod surface_window_tests;
