use crate::Rect;
use std::time::Duration;

pub(crate) const STABILITY_SAMPLE_INTERVAL: Duration = Duration::from_millis(17);
pub(crate) const MIN_STABILITY_SPAN: Duration = Duration::from_millis(34);
const GEOMETRY_TOLERANCE: f64 = 0.5;

pub(crate) struct StabilitySampler {
    previous: Option<Rect>,
    consecutive: u32,
    stable_since: Duration,
}

impl StabilitySampler {
    pub(crate) fn new() -> Self {
        Self {
            previous: None,
            consecutive: 0,
            stable_since: Duration::ZERO,
        }
    }

    pub(crate) fn observe(&mut self, bounds: Option<Rect>, elapsed: Duration) -> bool {
        let Some(bounds) = bounds else {
            self.previous = None;
            self.consecutive = 0;
            self.stable_since = elapsed;
            return false;
        };
        if self
            .previous
            .is_some_and(|previous| geometry_matches(previous, bounds))
        {
            self.consecutive += 1;
        } else {
            self.consecutive = 1;
            self.stable_since = elapsed;
        }
        self.previous = Some(bounds);
        self.consecutive >= 3 && elapsed.saturating_sub(self.stable_since) >= MIN_STABILITY_SPAN
    }

    pub(crate) fn samples(&self) -> u32 {
        self.consecutive
    }

    pub(crate) fn stable_span(&self, elapsed: Duration) -> Duration {
        elapsed.saturating_sub(self.stable_since)
    }

    pub(crate) fn bounds(&self) -> Option<Rect> {
        self.previous
    }
}

pub(crate) fn geometry_matches(left: Rect, right: Rect) -> bool {
    [
        (left.x, right.x),
        (left.y, right.y),
        (left.width, right.width),
        (left.height, right.height),
    ]
    .into_iter()
    .all(|(left, right)| (left - right).abs() <= GEOMETRY_TOLERANCE)
}

#[cfg(test)]
#[path = "stability_sampler_tests.rs"]
mod tests;
