use serde::{Deserialize, Deserializer, Serialize};

const MAX_GEOMETRY_MAGNITUDE: f64 = 10_000_000.0;

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq)]
pub struct Rect {
    #[serde(default, deserialize_with = "f64_or_zero")]
    pub x: f64,
    #[serde(default, deserialize_with = "f64_or_zero")]
    pub y: f64,
    #[serde(default, deserialize_with = "f64_or_zero")]
    pub width: f64,
    #[serde(default, deserialize_with = "f64_or_zero")]
    pub height: f64,
}

fn f64_or_zero<'de, D: Deserializer<'de>>(deserializer: D) -> Result<f64, D::Error> {
    Option::<f64>::deserialize(deserializer).map(|value| value.unwrap_or(0.0))
}

impl Rect {
    pub fn validate(self) -> Result<Self, crate::AdapterError> {
        let coordinates_valid = self.x.is_finite()
            && self.y.is_finite()
            && self.x.abs() <= MAX_GEOMETRY_MAGNITUDE
            && self.y.abs() <= MAX_GEOMETRY_MAGNITUDE;
        let size_valid = self.width.is_finite()
            && self.height.is_finite()
            && (0.0..=MAX_GEOMETRY_MAGNITUDE).contains(&self.width)
            && (0.0..=MAX_GEOMETRY_MAGNITUDE).contains(&self.height);
        if coordinates_valid && size_valid {
            return Ok(self);
        }
        Err(crate::AdapterError::new(
            crate::ErrorCode::InvalidArgs,
            "Rectangle must contain finite bounded coordinates and non-negative bounded dimensions",
        ))
    }

    pub fn bounds_hash(&self) -> Option<u64> {
        use rustc_hash::FxHasher;
        use std::hash::{Hash, Hasher};

        self.validate().ok()?;
        let mut hasher = FxHasher::default();
        for value in [self.x, self.y, self.width, self.height] {
            let canonical = (value * 100.0).round() as i64;
            canonical.hash(&mut hasher);
        }
        Some(hasher.finish())
    }
}

#[cfg(test)]
#[path = "rect_tests.rs"]
mod tests;
