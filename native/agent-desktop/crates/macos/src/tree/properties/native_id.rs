pub(crate) fn meaningful_native_id(raw: Option<String>) -> Option<String> {
    raw.filter(|id| !id.trim().is_empty())
}

pub(crate) fn meaningful_dom_id(raw: Option<String>) -> Option<String> {
    raw.filter(|id| !id.trim().is_empty())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn undocumented_ns_prefix_is_preserved() {
        assert_eq!(
            meaningful_native_id(Some("_NS:42".into())),
            Some("_NS:42".into())
        );
    }

    #[test]
    fn developer_assigned_id_is_kept() {
        assert_eq!(
            meaningful_native_id(Some("submit-btn".into())),
            Some("submit-btn".into())
        );
    }

    #[test]
    fn chromium_dom_id_is_kept_and_blank_is_rejected() {
        assert_eq!(
            meaningful_dom_id(Some("compose-message".into())),
            Some("compose-message".into())
        );
        assert_eq!(meaningful_dom_id(Some("  ".into())), None);
    }
}
