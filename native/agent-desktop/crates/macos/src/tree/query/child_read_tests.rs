use super::super::child_read_telemetry::record_status as record_error;
use super::imp::{is_absent_error, read_without_count};
use super::*;
use accessibility_sys::{
    kAXErrorAttributeUnsupported, kAXErrorCannotComplete, kAXErrorFailure, kAXErrorNoValue,
};

#[test]
fn child_reads_distinguish_expired_deadlines_from_invalid_elements() {
    let element = AXElement(std::ptr::null_mut());
    let expired = read_attribute_children(&element, "AXChildren", 1, std::time::Instant::now());

    assert!(!expired.complete);
    assert_eq!(expired.status.health.deadline_exhausted, 1);
    assert_eq!(expired.status.attempts, 0);
    assert!(!expired.status.invalid_element);

    for max_elements in [0, 1] {
        let invalid = read_attribute_children(
            &element,
            "AXChildren",
            max_elements,
            std::time::Instant::now() + std::time::Duration::from_secs(1),
        );

        assert!(!invalid.complete);
        assert!(!invalid.prefix_certain);
        assert_eq!(
            invalid.source_availability,
            ChildSourceAvailability::Unknown
        );
        assert!(invalid.status.invalid_element);
        assert_eq!(invalid.status.health.deadline_exhausted, 0);
        assert_eq!(invalid.status.attempts, 1 + max_elements as u64);
    }
}

#[test]
fn unsupported_and_missing_child_attributes_are_authoritatively_absent() {
    assert!(is_absent_error(kAXErrorAttributeUnsupported));
    assert!(is_absent_error(kAXErrorNoValue));
    assert!(!is_absent_error(kAXErrorCannotComplete));
}

#[test]
fn indexed_child_requires_a_successful_unchanged_final_count() {
    for final_count in [
        Ok(1),
        Ok(0),
        Ok(2),
        Err(kAXErrorFailure),
        Err(kAXErrorNoValue),
        Err(kAXErrorAttributeUnsupported),
        Err(kAXErrorCannotComplete),
        Err(i32::MIN),
    ] {
        let mut status = ChildReadStatus {
            attempts: 3,
            ..Default::default()
        };
        if let Err(error) = final_count {
            record_error(&mut status, error);
        }
        let read = ChildRead::indexed(
            vec![AXElement(std::ptr::null_mut())],
            1,
            0,
            final_count,
            status,
        );
        assert_eq!(read.complete, final_count == Ok(1));
        assert_eq!(read.prefix_certain, read.complete);
        assert_eq!(read.status.attempts, 3);
        if final_count == Err(kAXErrorFailure) {
            assert_eq!(read.status.health.native_read_failures, 1);
        }
    }
}

#[test]
fn cursor_stall_is_preserved_when_statuses_merge() {
    let mut status = ChildReadStatus::default();
    status.merge(ChildReadStatus {
        cursor_stalled: true,
        health: agent_desktop_core::LocatorReadHealth {
            native_read_failures: 2,
            ..Default::default()
        },
        ..ChildReadStatus::default()
    });

    assert!(status.cursor_stalled);
    assert_eq!(status.health.native_read_failures, 2);
}

#[test]
fn indexed_child_read_is_not_rejected_for_unread_siblings() {
    let read = ChildRead::indexed(
        vec![AXElement(std::ptr::null_mut())],
        10_000,
        3,
        Ok(10_000),
        ChildReadStatus::default(),
    );

    assert!(read.complete);
    assert!(read.truncated());
}

#[test]
fn positive_short_pages_continue_from_the_advanced_offset() {
    let mut calls = Vec::new();
    let result = read_paged_prefix(4, 128, |offset, maximum| {
        calls.push((offset, maximum));
        Ok(if offset == 0 { vec![0, 1] } else { vec![2, 3] })
    })
    .unwrap();

    assert_eq!(calls, [(0, 4), (2, 2)]);
    assert_eq!(result.elements, [0, 1, 2, 3]);
    assert!(!result.stalled);
}

#[test]
fn zero_progress_stalls_and_terminates_before_the_requested_count() {
    let mut calls = Vec::new();
    let result = read_paged_prefix(4, 128, |offset, maximum| {
        calls.push((offset, maximum));
        Ok(if offset == 0 { vec![0, 1] } else { Vec::new() })
    })
    .unwrap();

    assert_eq!(calls, [(0, 4), (2, 2)]);
    assert_eq!(result.elements, [0, 1]);
    assert!(result.stalled);
}

#[test]
fn multi_page_reads_preserve_order_beyond_the_native_page_size() {
    let mut calls = Vec::new();
    let result = read_paged_prefix(260, 128, |offset, maximum| {
        calls.push((offset, maximum));
        Ok((offset..offset + maximum).collect::<Vec<_>>())
    })
    .unwrap();

    assert_eq!(calls, [(0, 128), (128, 128), (256, 4)]);
    assert_eq!(result.elements, (0..260).collect::<Vec<_>>());
    assert!(!result.stalled);
}

#[test]
fn page_error_after_progress_is_not_collapsed_to_a_short_complete_read() {
    let error = read_paged_prefix(4, 128, |offset, _| {
        if offset == 0 {
            Ok(vec![0, 1])
        } else {
            Err(kAXErrorCannotComplete)
        }
    })
    .err()
    .expect("a later native error must remain visible");

    assert_eq!(error, kAXErrorCannotComplete);
}

#[test]
fn unclassified_native_error_is_counted_explicitly() {
    let mut status = ChildReadStatus::default();

    record_error(&mut status, i32::MIN);

    assert_eq!(status.health.native_read_failures, 1);
    assert_eq!(status.health.cannot_complete, 0);
    assert!(!status.invalid_element);
    assert!(!status.api_disabled);
}

#[test]
fn ax_failure_remains_a_native_read_failure() {
    let mut status = ChildReadStatus::default();

    record_error(&mut status, kAXErrorFailure);

    assert_eq!(status.health.native_read_failures, 1);
    assert_eq!(status.health.cannot_complete, 0);
}

#[test]
fn count_fallback_preserves_a_terminal_prefix_failure() {
    let mut status = ChildReadStatus {
        attempts: 1,
        ..Default::default()
    };
    record_error(&mut status, kAXErrorCannotComplete);
    let read = read_without_count(
        &AXElement(std::ptr::null_mut()),
        "AXChildren",
        1,
        std::time::Instant::now() + std::time::Duration::from_secs(1),
        status,
    );

    assert!(read.status.invalid_element);
    assert_eq!(read.status.health.cannot_complete, 1);
    assert_eq!(read.status.attempts, 2);
    assert!(!read.complete);
    assert!(!read.prefix_certain);
}
