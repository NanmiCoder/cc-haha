use crate::types::point::AdPoint;
use agent_desktop_core::{DragParams as CoreDragParams, Point as CorePoint};

/// Caller-allocated drag parameters. Callers must zero-initialize the whole
/// struct before setting fields so unset numeric fields read as the `0`
/// adapter-default sentinel rather than stack garbage. Verify layout against
/// `AD_DRAG_PARAMS_SIZE` / `ad_drag_params_size()` when binding from a language
/// whose struct layout may diverge.
#[repr(C)]
pub struct AdDragParams {
    pub from: AdPoint,
    pub to: AdPoint,
    pub duration_ms: u64,
    pub drop_delay_ms: u64,
}

pub const AD_DRAG_PARAMS_SIZE: usize = 48;

const _: () = assert!(std::mem::size_of::<AdDragParams>() == AD_DRAG_PARAMS_SIZE);

#[unsafe(no_mangle)]
pub extern "C" fn ad_drag_params_size() -> usize {
    std::mem::size_of::<AdDragParams>()
}

impl AdDragParams {
    /// Converts the C drag params into the core type. `duration_ms` and
    /// `drop_delay_ms` use `0` as the "adapter default" sentinel because the
    /// C ABI has no `Option`; any non-zero value is passed through.
    pub(crate) fn to_core(&self) -> CoreDragParams {
        CoreDragParams {
            from: CorePoint {
                x: self.from.x,
                y: self.from.y,
            },
            to: CorePoint {
                x: self.to.x,
                y: self.to.y,
            },
            duration_ms: zero_as_default(self.duration_ms),
            drop_delay_ms: zero_as_default(self.drop_delay_ms),
        }
    }
}

fn zero_as_default(value: u64) -> Option<u64> {
    (value != 0).then_some(value)
}
