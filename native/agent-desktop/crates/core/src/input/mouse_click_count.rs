use crate::{AdapterError, DeliverySemantics, ErrorCode};

pub const MAX_MOUSE_CLICK_COUNT: u32 = 100;

pub fn validate_mouse_click_count(count: u32) -> Result<(), AdapterError> {
    if (1..=MAX_MOUSE_CLICK_COUNT).contains(&count) {
        return Ok(());
    }
    Err(AdapterError::new(
        ErrorCode::InvalidArgs,
        format!("Mouse click count must be between 1 and {MAX_MOUSE_CLICK_COUNT}"),
    )
    .with_disposition(DeliverySemantics::not_delivered()))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn accepts_bounded_positive_counts() {
        assert!(validate_mouse_click_count(1).is_ok());
        assert!(validate_mouse_click_count(MAX_MOUSE_CLICK_COUNT).is_ok());
    }

    #[test]
    fn rejects_zero_and_unbounded_counts() {
        assert_eq!(
            validate_mouse_click_count(0).unwrap_err().disposition,
            DeliverySemantics::not_delivered()
        );
        assert_eq!(
            validate_mouse_click_count(0).unwrap_err().code,
            ErrorCode::InvalidArgs
        );
        assert_eq!(
            validate_mouse_click_count(MAX_MOUSE_CLICK_COUNT + 1)
                .unwrap_err()
                .code,
            ErrorCode::InvalidArgs
        );
    }
}
