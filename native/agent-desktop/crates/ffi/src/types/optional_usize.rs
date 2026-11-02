#[repr(C)]
pub struct AdOptionalUsize {
    pub value: usize,
    pub present: bool,
}

pub const AD_OPTIONAL_USIZE_SIZE: usize = 16;

const _: () = assert!(std::mem::size_of::<AdOptionalUsize>() == AD_OPTIONAL_USIZE_SIZE);
