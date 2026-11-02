use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct Point {
    pub x: f64,
    pub y: f64,
}

impl Point {
    pub fn validate(&self) -> Result<(), crate::AdapterError> {
        const MAX_COORDINATE: f64 = 10_000_000.0;
        if self.x.is_finite()
            && self.y.is_finite()
            && self.x.abs() <= MAX_COORDINATE
            && self.y.abs() <= MAX_COORDINATE
        {
            return Ok(());
        }
        Err(crate::AdapterError::new(
            crate::ErrorCode::InvalidArgs,
            "Point coordinates must be finite and within platform geometry bounds",
        ))
    }
}
