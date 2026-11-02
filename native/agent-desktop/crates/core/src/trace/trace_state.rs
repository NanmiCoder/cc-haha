use std::{
    path::PathBuf,
    sync::{Arc, Mutex, atomic::AtomicBool},
};

#[derive(Debug, Clone, Default)]
pub(crate) enum TracePending {
    #[default]
    None,
    File(PathBuf),
    SegmentDir(PathBuf),
}

#[derive(Debug, Clone, Default)]
pub(crate) enum TraceWriterState {
    #[default]
    Unopened,
    Open(Arc<Mutex<std::fs::File>>),
    Failed,
}

#[derive(Debug, Default)]
pub(crate) struct TraceState {
    pub(crate) pending: TracePending,
    pub(crate) emission: Mutex<()>,
    pub(crate) writer: Arc<Mutex<TraceWriterState>>,
    pub(crate) meta_written: AtomicBool,
}
