use crate::{ProcessId, SnapshotSurface};

#[derive(Clone, Copy)]
pub(crate) struct RefAllocSource<'a> {
    pub(crate) pid: ProcessId,
    pub(crate) app: Option<&'a str>,
    pub(crate) window_id: Option<&'a str>,
    pub(crate) window_title: Option<&'a str>,
    pub(crate) window_bounds_hash: Option<u64>,
    pub(crate) process_instance: Option<&'a str>,
    pub(crate) surface: SnapshotSurface,
}
