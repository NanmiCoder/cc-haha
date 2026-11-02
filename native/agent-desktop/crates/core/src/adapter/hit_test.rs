use crate::Rect;
use serde::{Deserialize, Serialize};

/// Classifies whether a hit-tested point reaches the intended target. A hit
/// on the target itself or one of its descendants reaches it; a hit outside
/// the target's ancestor chain names a real occluder (modal, overlay,
/// sibling); a hit on the target's own ancestor is `Unknown` rather than a
/// false occlusion, since composited or custom-drawn views often expose no
/// distinct child node to hit-test. Probe failures are `Unknown` for the
/// same reason: unavailable evidence is never a false failure.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub enum HitTestResult {
    ReachesTarget,
    InterceptedBy {
        #[serde(skip_serializing_if = "Option::is_none")]
        role: Option<String>,
        #[serde(skip_serializing_if = "Option::is_none")]
        name: Option<String>,
        #[serde(skip_serializing_if = "Option::is_none")]
        bounds: Option<Rect>,
    },
    Unknown,
}

#[cfg(test)]
#[path = "hit_test_tests.rs"]
mod tests;
