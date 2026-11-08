#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct DirectoryIdentity {
    pub(crate) path: std::path::PathBuf,
    pub(crate) device: u64,
    pub(crate) inode: u64,
    pub(crate) owner: u32,
    pub(crate) mode: u32,
}
