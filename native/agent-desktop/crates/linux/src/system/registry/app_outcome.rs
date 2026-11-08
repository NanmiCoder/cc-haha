use super::registry_frames::RootRead;

/// How far the read of one selected application's frames got. `app` indexes
/// `Registry::apps`.
pub(crate) struct AppOutcome {
    pub(crate) app: usize,
    pub(crate) read: RootRead,
}
