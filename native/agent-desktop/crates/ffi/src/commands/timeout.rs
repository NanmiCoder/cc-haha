use agent_desktop_core::{AdapterError, ErrorCode};

pub(crate) fn decode_ref_action_timeout(timeout_ms: i64) -> Result<u64, AdapterError> {
    match timeout_ms {
        -1 => Ok(crate::operation::DEFAULT_FFI_TIMEOUT_MS),
        0.. => Ok(timeout_ms as u64),
        _ => Err(AdapterError::new(
            ErrorCode::InvalidArgs,
            "timeout_ms must be -1 for the default, 0 for single-shot, or a positive millisecond budget",
        )),
    }
}

#[cfg(test)]
mod tests {
    use super::decode_ref_action_timeout;

    #[test]
    fn signed_timeout_preserves_default_and_single_shot_sentinels() {
        assert_eq!(decode_ref_action_timeout(-1).unwrap(), 5_000);
        assert_eq!(decode_ref_action_timeout(0).unwrap(), 0);
        assert_eq!(decode_ref_action_timeout(250).unwrap(), 250);
    }

    #[test]
    fn signed_timeout_rejects_values_below_default_sentinel() {
        let err = decode_ref_action_timeout(-2).unwrap_err();
        assert_eq!(err.code.as_str(), "INVALID_ARGS");
    }
}
