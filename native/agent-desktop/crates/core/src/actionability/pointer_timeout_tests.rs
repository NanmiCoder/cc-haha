use super::*;
use crate::{ErrorCode, RetryDisposition};

fn report(code: &str, complete: bool) -> Value {
    json!({
        "code": code,
        "message": "Stored ref does not match any live element",
        "details": { "kind": "resolve_no_candidate", "complete": complete },
    })
}

fn adapter_error(error: AppError) -> crate::AdapterError {
    let AppError::Adapter(error) = error else {
        panic!("expected an adapter error");
    };
    error
}

#[test]
fn a_complete_stale_report_is_a_not_delivered_stale_ref() {
    let error = adapter_error(point_actionability_timeout(Some(report("STALE_REF", true))));

    assert_eq!(error.code, ErrorCode::StaleRef);
    assert_eq!(error.disposition, crate::DeliverySemantics::not_delivered());
    assert_eq!(error.disposition.retry(), RetryDisposition::Safe);
}

#[test]
fn a_complete_ambiguous_report_is_an_ambiguous_target() {
    let error = adapter_error(point_actionability_timeout(Some(report(
        "AMBIGUOUS_TARGET",
        true,
    ))));

    assert_eq!(error.code, ErrorCode::AmbiguousTarget);
    assert_eq!(error.disposition, crate::DeliverySemantics::not_delivered());
}

#[test]
fn an_incomplete_report_stays_a_not_delivered_timeout() {
    let error = adapter_error(point_actionability_timeout(Some(report(
        "STALE_REF",
        false,
    ))));

    assert_eq!(error.code, ErrorCode::Timeout);
    assert_eq!(error.disposition, crate::DeliverySemantics::not_delivered());
}
