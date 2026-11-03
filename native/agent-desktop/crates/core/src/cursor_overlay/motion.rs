use super::hand_path::HandPath;
use super::path_shape::PathShape;
use super::{CursorMotionProfile, CursorPose};
use crate::Point;

const RIPPLE_MS: u64 = 300;

pub struct CursorMotion {
    path: HandPath,
    duration_ms: u64,
    dwell_ms: u64,
    click: bool,
    ripple: bool,
}

impl CursorMotion {
    pub fn new(start: Point, destination: Point) -> Self {
        Self::shaped(start, destination, &CursorMotionProfile::default(), 0)
    }

    /// Overlay motion tuned by `profile`; `move_index` varies seeded paths
    /// from one move to the next. A profile that fails validation falls back
    /// to the default motion.
    pub fn shaped(
        start: Point,
        destination: Point,
        profile: &CursorMotionProfile,
        move_index: u64,
    ) -> Self {
        let fallback;
        let profile = if profile.validate().is_ok() {
            profile
        } else {
            fallback = CursorMotionProfile::default();
            &fallback
        };
        let path = HandPath::shaped(
            start,
            destination,
            &PathShape::from_profile(profile, move_index),
        );
        let duration_ms = path.duration_ms(profile.travel_ms());
        Self {
            path,
            duration_ms,
            dwell_ms: profile.dwell_ms(),
            click: false,
            ripple: true,
        }
    }

    pub const fn with_impact(mut self, click: bool) -> Self {
        self.click = click;
        self
    }

    pub const fn with_ripple(mut self, ripple: bool) -> Self {
        self.ripple = ripple;
        self
    }

    pub const fn duration_ms(&self) -> u64 {
        self.duration_ms
    }

    pub const fn dwell_ms(&self) -> u64 {
        self.dwell_ms
    }

    pub const fn total_ms(&self) -> u64 {
        let settled = self.settled_ms();
        if self.plays_ripple() {
            settled + RIPPLE_MS
        } else {
            settled
        }
    }

    pub fn sample(&self, elapsed_ms: u64) -> Point {
        if elapsed_ms >= self.duration_ms {
            return self.path.destination();
        }
        self.path.at(elapsed_ms as f64 / self.duration_ms as f64)
    }

    pub fn pose(&self, elapsed_ms: u64) -> CursorPose {
        let point = self.sample(elapsed_ms.min(self.duration_ms));
        let settled = self.settled_ms();
        if !self.plays_ripple() || elapsed_ms <= settled {
            return CursorPose::still(point);
        }
        CursorPose {
            point,
            ripple: ((elapsed_ms - settled) as f64 / RIPPLE_MS as f64).clamp(0.0, 1.0),
        }
    }

    const fn settled_ms(&self) -> u64 {
        self.duration_ms + self.dwell_ms
    }

    const fn plays_ripple(&self) -> bool {
        self.click && self.ripple
    }
}
