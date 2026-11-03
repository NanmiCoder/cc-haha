use crate::types::action_step::AdActionStep;
use crate::types::delivery_semantics::AdDeliverySemantics;
use crate::types::element_state::AdElementState;
use std::os::raw::c_char;

#[repr(C)]
pub struct AdActionResult {
    pub action: *const c_char,
    pub ref_id: *const c_char,
    pub post_state: *mut AdElementState,
    pub steps: *mut AdActionStep,
    pub step_count: u32,
    pub details_json: *const c_char,
    pub disposition: AdDeliverySemantics,
}

pub const AD_ACTION_RESULT_SIZE: usize = 56;

const _: () = assert!(std::mem::size_of::<AdActionResult>() == AD_ACTION_RESULT_SIZE);

#[unsafe(no_mangle)]
pub extern "C" fn ad_action_result_size() -> usize {
    std::mem::size_of::<AdActionResult>()
}
