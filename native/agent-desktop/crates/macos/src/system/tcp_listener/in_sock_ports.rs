#[repr(C)]
#[derive(Clone, Copy)]
pub(crate) struct InSockPorts {
    pub(crate) foreign: i32,
    pub(crate) local: i32,
}
