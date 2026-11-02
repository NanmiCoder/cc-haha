#[repr(C)]
pub struct AdWaitSurfaceModes {
    pub menu: bool,
    pub menu_closed: bool,
    pub notification: bool,
}

pub const AD_WAIT_SURFACE_MODES_SIZE: usize = 3;

const _: () = assert!(std::mem::size_of::<AdWaitSurfaceModes>() == AD_WAIT_SURFACE_MODES_SIZE);
