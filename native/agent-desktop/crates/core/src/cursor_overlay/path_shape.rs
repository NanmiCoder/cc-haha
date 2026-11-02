use super::CursorMotionProfile;

pub(super) struct PathShape {
    pub(super) bow_scale: f64,
    pub(super) overshoot: f64,
    pub(super) tremor_px: f64,
    pub(super) seed: Option<u64>,
    pub(super) move_index: u64,
}

impl PathShape {
    pub(super) fn from_profile(profile: &CursorMotionProfile, move_index: u64) -> Self {
        Self {
            bow_scale: profile.bow(),
            overshoot: profile.overshoot(),
            tremor_px: profile.tremor(),
            seed: profile.seed(),
            move_index,
        }
    }
}
