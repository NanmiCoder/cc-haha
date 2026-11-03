#[repr(C)]
pub struct AdFindSelection {
    pub kind: i32,
    pub nth: u32,
}

pub const AD_FIND_SELECTION_SIZE: usize = 8;

const _: () = assert!(std::mem::size_of::<AdFindSelection>() == AD_FIND_SELECTION_SIZE);
