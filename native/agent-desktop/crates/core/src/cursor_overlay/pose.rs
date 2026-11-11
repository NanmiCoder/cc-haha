use crate::Point;

#[derive(Debug, Clone, PartialEq)]
pub struct CursorPose {
    pub point: Point,
    pub ripple: f64,
}

impl CursorPose {
    pub const fn still(point: Point) -> Self {
        Self { point, ripple: 0.0 }
    }
}
