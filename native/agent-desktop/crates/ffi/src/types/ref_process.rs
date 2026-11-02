#[repr(C)]
pub struct AdRefProcess {
    pub pid: u32,
}

pub const AD_REF_PROCESS_SIZE: usize = 4;

const _: () = assert!(std::mem::size_of::<AdRefProcess>() == AD_REF_PROCESS_SIZE);
