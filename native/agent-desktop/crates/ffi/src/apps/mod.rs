pub(crate) mod close;
pub(crate) mod launch;
pub(crate) mod list;

use agent_desktop_core::AdapterError;
use std::os::raw::c_char;

fn decode_app_id(id: *const c_char) -> Result<String, AdapterError> {
    crate::convert::string::required_adapter_string(id, "app id")
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::convert::string::{AD_MAX_STRING_BYTES, string_to_c};

    #[test]
    fn app_id_rejects_null() {
        let err = decode_app_id(std::ptr::null()).unwrap_err();

        assert_eq!(err.message, "app id is null");
    }

    #[test]
    fn app_id_rejects_invalid_utf8() {
        let bad = [0xC3_u8, 0];
        let err = decode_app_id(bad.as_ptr().cast()).unwrap_err();

        assert_eq!(err.message, "app id is not valid UTF-8");
    }

    #[test]
    fn app_id_rejects_overlong_input() {
        let bytes = vec![b'a'; AD_MAX_STRING_BYTES + 1];
        let err = decode_app_id(bytes.as_ptr().cast()).unwrap_err();

        assert!(
            err.message
                .starts_with("app id exceeds AD_MAX_STRING_BYTES")
        );
    }

    #[test]
    fn app_id_accepts_valid_utf8() {
        let c = string_to_c("TextEdit");
        let decoded = decode_app_id(c).unwrap();

        assert_eq!(decoded, "TextEdit");
        unsafe { crate::convert::string::free_c_string(c) };
    }
}
