use super::attach_modern_failure;
use agent_desktop_core::{AdapterError, ErrorCode};

fn error(message: &str) -> AdapterError {
    AdapterError::new(ErrorCode::ActionFailed, message)
}

/// `None` means Modern was never attempted (unsupported) or is irrelevant to
/// report, so the caller must see exactly the Legacy failure it already has -
/// compared field by field rather than by message alone, since a rewrite that
/// started attaching a detail here would otherwise slip past a looser check.
#[test]
fn no_modern_failure_leaves_the_legacy_error_completely_unchanged() {
    let legacy = error("legacy boom")
        .with_platform_detail("legacy detail")
        .with_suggestion("retry legacy capture");

    let result = attach_modern_failure(legacy.clone(), None);

    assert_eq!(result.code, legacy.code);
    assert_eq!(result.message, legacy.message);
    assert_eq!(result.platform_detail, legacy.platform_detail);
    assert_eq!(result.suggestion, legacy.suggestion);
}

#[test]
fn a_modern_failure_is_named_in_platform_detail_when_legacy_carried_none() {
    let legacy = error("legacy boom");
    let modern = error("modern boom");

    let result = attach_modern_failure(legacy.clone(), Some(&modern));

    assert_eq!(result.code, legacy.code);
    assert_eq!(result.message, legacy.message);
    assert_eq!(
        result.platform_detail.as_deref(),
        Some("modern capture first failed: modern boom")
    );
}

/// The existing detail is the more specific, Legacy-side diagnosis; losing it
/// to make room for the Modern failure would trade one useful fact for
/// another instead of keeping both.
#[test]
fn a_modern_failure_is_appended_to_an_existing_legacy_detail_rather_than_replacing_it() {
    let legacy = error("legacy boom").with_platform_detail("legacy detail");
    let modern = error("modern boom");

    let result = attach_modern_failure(legacy, Some(&modern));

    assert_eq!(
        result.platform_detail.as_deref(),
        Some("legacy detail; modern capture first failed: modern boom")
    );
}
