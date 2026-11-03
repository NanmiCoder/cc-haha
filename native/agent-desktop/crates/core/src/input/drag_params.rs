use serde::{Deserialize, Serialize};

use crate::Point;

pub const MAX_DRAG_DURATION_MS: u64 = 60_000;
pub const MAX_DRAG_DROP_DELAY_MS: u64 = 10_000;
pub const MAX_DRAG_STEPS: u64 = 4_096;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DragParams {
    pub from: Point,
    pub to: Point,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub duration_ms: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub drop_delay_ms: Option<u64>,
}

impl DragParams {
    pub fn validate(&self, deadline: crate::Deadline) -> Result<(), crate::AdapterError> {
        self.from.validate()?;
        self.to.validate()?;
        let total = Self::validate_timing(self.duration_ms, self.drop_delay_ms, deadline)?;
        if deadline.remaining() < std::time::Duration::from_millis(total) {
            return Err(deadline.timeout_error());
        }
        Ok(())
    }

    pub(crate) fn validate_timing(
        duration_ms: Option<u64>,
        drop_delay_ms: Option<u64>,
        deadline: crate::Deadline,
    ) -> Result<u64, crate::AdapterError> {
        let duration = duration_ms.unwrap_or(0);
        let drop_delay = drop_delay_ms.unwrap_or(0);
        if duration > MAX_DRAG_DURATION_MS || drop_delay > MAX_DRAG_DROP_DELAY_MS {
            return Err(crate::AdapterError::new(
                crate::ErrorCode::InvalidArgs,
                "Drag timing exceeds the supported maximum",
            ));
        }
        let total = duration.checked_add(drop_delay).ok_or_else(|| {
            crate::AdapterError::new(crate::ErrorCode::InvalidArgs, "Drag timing overflows")
        })?;
        let steps = duration.div_ceil(16).max(1);
        if steps > MAX_DRAG_STEPS {
            return Err(crate::AdapterError::new(
                crate::ErrorCode::InvalidArgs,
                "Drag would exceed the maximum synthesized step count",
            ));
        }
        if total > 0 && total >= deadline.timeout_ms() {
            return Err(crate::AdapterError::new(
                crate::ErrorCode::InvalidArgs,
                "Drag --duration plus --drop-delay must be less than --timeout-ms; allow additional time for pickup, resolution and completion",
            )
            .with_details(serde_json::json!({
                "duration_ms": duration,
                "drop_delay_ms": drop_delay,
                "timeout_ms": deadline.timeout_ms(),
            }))
            .with_disposition(crate::DeliverySemantics::not_delivered()));
        }
        Ok(total)
    }
}
