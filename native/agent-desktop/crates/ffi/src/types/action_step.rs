use std::os::raw::c_char;

#[repr(C)]
pub struct AdActionStep {
    pub label: *const c_char,
    pub outcome: *const c_char,
    pub mechanism: i32,
    pub has_mechanism: bool,
    pub verified: bool,
    pub has_verified: bool,
    pub _reserved: u64,
}

pub const AD_ACTION_STEP_SIZE: usize = 32;

const _: () = assert!(std::mem::size_of::<AdActionStep>() == AD_ACTION_STEP_SIZE);

#[unsafe(no_mangle)]
pub extern "C" fn ad_action_step_size() -> usize {
    std::mem::size_of::<AdActionStep>()
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::mem::{offset_of, size_of};

    #[test]
    fn layout_matches_published_abi() {
        assert_eq!(size_of::<AdActionStep>(), AD_ACTION_STEP_SIZE);
        assert_eq!(offset_of!(AdActionStep, label), 0);
        assert_eq!(offset_of!(AdActionStep, outcome), 8);
        assert_eq!(offset_of!(AdActionStep, mechanism), 16);
        assert_eq!(offset_of!(AdActionStep, has_mechanism), 20);
        assert_eq!(offset_of!(AdActionStep, verified), 21);
        assert_eq!(offset_of!(AdActionStep, has_verified), 22);
        assert_eq!(offset_of!(AdActionStep, _reserved), 24);
    }
}
