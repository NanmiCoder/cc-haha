use crate::AdAdapter;
use crate::convert::surface::snapshot_surface_from_c;
use crate::error::{AdResult, set_last_error};
use crate::ffi_try::trap_panic;
use crate::tree::flatten::flatten_tree;
use crate::types::{AdExactWindowInfo, AdNodeTree, AdTreeOptions};
use std::ptr;

/// Snapshots a generation-pinned window into the flat, owned, breadth-first C
/// tree layout. Direct children are contiguous at
/// `nodes[child_start..child_start + child_count]`; free the result with
/// `ad_free_tree`.
///
/// This is a raw adapter tree: nodes do not receive refs, no refmap is
/// persisted, and no JSON envelope is produced. `max_depth`, `surface`,
/// `include_bounds`, `interactive_only`, and `compact` are applied; skeleton
/// and drill-down behavior are not. Use `ad_snapshot` for the canonical
/// observe-act workflow with snapshot-qualified refs.
///
/// # Safety
/// All pointers must be valid and `out` must be writable.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn ad_get_tree_exact(
    adapter: *const AdAdapter,
    win: *const AdExactWindowInfo,
    opts: *const AdTreeOptions,
    out: *mut AdNodeTree,
) -> AdResult {
    trap_panic(|| unsafe {
        crate::pointer_guard::guard_non_null!(out, c"out is null");
        (*out).nodes = ptr::null_mut();
        (*out).count = 0;
        crate::pointer_guard::guard_non_null!(adapter, c"adapter is null");
        crate::pointer_guard::guard_non_null!(win, c"win is null");
        crate::pointer_guard::guard_non_null!(opts, c"opts is null");
        let window = match crate::windows::ad_exact_window_to_core(&*win) {
            Ok(window) => window,
            Err(error) => {
                set_last_error(&error);
                return crate::error::last_error_code();
            }
        };
        get_core_tree(adapter, &window, &*opts, out)
    })
}

unsafe fn get_core_tree(
    adapter: *const AdAdapter,
    window: &agent_desktop_core::WindowInfo,
    options: &AdTreeOptions,
    out: *mut AdNodeTree,
) -> AdResult {
    let surface = match snapshot_surface_from_c(options.surface, "snapshot surface") {
        Ok(surface) => surface,
        Err(e) => {
            set_last_error(&e);
            return AdResult::ErrInvalidArgs;
        }
    };
    let core_opts = agent_desktop_core::TreeOptions {
        max_depth: options.max_depth,
        include_bounds: options.include_bounds,
        interactive_only: options.interactive_only,
        compact: options.compact,
        surface,
        skeleton: false,
        force_renderer_accessibility: false,
    };
    let adapter = crate::adapter::acquire_adapter!(adapter);
    let deadline = crate::operation::operation_deadline!();

    match adapter.inner.get_tree(window, &core_opts, deadline) {
        Ok(tree) => {
            let shaped = agent_desktop_core::refs::ref_alloc::transform_tree(
                tree,
                core_opts.include_bounds,
                core_opts.interactive_only,
                core_opts.compact,
            );
            match flatten_tree(&shaped) {
                Ok(tree) => {
                    unsafe { *out = tree };
                    AdResult::Ok
                }
                Err(error) => {
                    set_last_error(&error);
                    crate::error::last_error_code()
                }
            }
        }
        Err(e) => {
            set_last_error(&e);
            crate::error::last_error_code()
        }
    }
}
