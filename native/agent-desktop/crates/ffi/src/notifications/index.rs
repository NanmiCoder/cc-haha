use agent_desktop_core::{AdapterError, ErrorCode};

pub(crate) fn notification_index(index: u32) -> Result<usize, AdapterError> {
    if index == 0 {
        return Err(AdapterError::new(
            ErrorCode::InvalidArgs,
            "Notification index is 1-based and must be greater than zero",
        ));
    }
    Ok(index as usize)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn index_is_one_based() {
        assert!(notification_index(0).is_err());
        assert_eq!(notification_index(1).unwrap(), 1);
    }
}
