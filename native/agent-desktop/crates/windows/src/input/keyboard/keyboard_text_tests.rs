use super::*;
use crate::input::keyboard::keyboard_send::keyboard_send_fake_sink as sink;
use agent_desktop_core::Deadline;

fn ample_deadline() -> Deadline {
    Deadline::after(5_000).expect("bounded deadline")
}

#[test]
fn text_chunks_preserve_unicode_without_splitting_surrogates() {
    let text = format!("{}😀tail", "a".repeat(TEXT_CHUNK_UTF16 - 1));
    let chunks = text_chunks(&text, None).unwrap();
    let roundtrip = String::from_utf16(&chunks.concat()).unwrap();

    assert_eq!(roundtrip, text);
    assert!(chunks.iter().all(|chunk| chunk.len() <= TEXT_CHUNK_UTF16));
}

#[test]
fn text_budget_rejects_unbounded_payloads() {
    let text = "x".repeat(MAX_TEXT_UTF16 + 1);
    let error = text_chunks(&text, None).expect_err("oversized text must fail before SendInput");

    assert_eq!(error.code, ErrorCode::InvalidArgs);
}

#[test]
fn oversized_text_is_rejected_by_synthesize_text_with_zero_injection() {
    sink::reset();
    let text = "x".repeat(MAX_TEXT_UTF16 + 1);

    let error =
        synthesize_text(&text, ample_deadline(), |_| Ok(())).expect_err("oversized text rejects");

    assert_eq!(error.code, ErrorCode::InvalidArgs);
    assert!(sink::recorded().is_empty());
}

#[test]
fn impossible_delivery_deadline_fails_before_input() {
    let deadline = Deadline::after(1).unwrap();
    let error = preflight_text("payload", deadline).expect_err("deadline must reject the plan");

    assert_eq!(error.code, ErrorCode::Timeout);
    assert_eq!(error.disposition, DeliverySemantics::not_delivered());
}

#[test]
fn pre_delivery_chunk_budget_check_reports_not_delivered_when_nothing_sent() {
    let deadline = Deadline::after(1).unwrap();
    std::thread::sleep(Duration::from_millis(15));

    let error = ensure_chunk_budget(deadline, 5, 0).expect_err("expired deadline must fail");

    assert_eq!(error.disposition, DeliverySemantics::not_delivered());
    let details = error.details.expect("timeout carries chunk accounting");
    assert_eq!(details["delivered_chunks"], 0);
    assert_eq!(details["total_chunks"], 5);
}

/// Mid-text deadline: some chunks already landed, so the disposition must
/// never claim nothing was delivered - inverted against the pre-delivery
/// case above.
#[test]
fn mid_text_chunk_budget_check_reports_delivered_unverified_with_counts() {
    let deadline = Deadline::after(1).unwrap();
    std::thread::sleep(Duration::from_millis(15));

    let error = ensure_chunk_budget(deadline, 5, 2).expect_err("expired deadline must fail");

    assert_eq!(error.disposition, DeliverySemantics::delivered_unverified());
    let details = error.details.expect("timeout carries chunk accounting");
    assert_eq!(details["delivered_chunks"], 2);
    assert_eq!(details["total_chunks"], 5);
}

#[test]
fn a_short_payload_posts_exactly_one_down_up_pair_per_utf16_unit() {
    sink::reset();
    let text = "hi";

    synthesize_text(text, ample_deadline(), |_| Ok(())).expect("ample deadline succeeds");

    let recorded = sink::recorded();
    assert_eq!(recorded.len(), text.encode_utf16().count() * 2);
    assert!(
        recorded
            .iter()
            .all(|event| event.flags & KEYEVENTF_UNICODE == KEYEVENTF_UNICODE)
    );
}

#[test]
fn a_payload_spanning_multiple_chunks_delivers_every_unit_in_order() {
    sink::reset();
    let text = "a".repeat(TEXT_CHUNK_UTF16 * 2 + 3);

    synthesize_text(&text, ample_deadline(), |_| Ok(())).expect("ample deadline succeeds");

    let recorded = sink::recorded();
    assert_eq!(recorded.len(), text.encode_utf16().count() * 2);
    let downs = recorded
        .iter()
        .filter(|event| event.flags == KEYEVENTF_UNICODE)
        .count();
    let ups = recorded
        .iter()
        .filter(|event| event.flags == KEYEVENTF_UNICODE | KEYEVENTF_KEYUP)
        .count();
    assert_eq!(downs, text.encode_utf16().count());
    assert_eq!(ups, text.encode_utf16().count());
}

#[test]
fn crlf_posts_one_line_break() {
    sink::reset();

    synthesize_text("a\r\nb", ample_deadline(), |_| Ok(())).expect("ample deadline succeeds");

    let downs: Vec<u16> = sink::recorded()
        .iter()
        .filter(|event| event.flags == KEYEVENTF_UNICODE)
        .map(|event| event.scan)
        .collect();
    assert_eq!(downs, "a\rb".encode_utf16().collect::<Vec<_>>());
}

#[test]
fn lone_lf_and_lone_cr_are_posted_unchanged() {
    let chunks = text_chunks("a\nb\rc\n\rd", None).unwrap();

    assert_eq!(
        String::from_utf16(&chunks.concat()).unwrap(),
        "a\nb\rc\n\rd"
    );
}

#[test]
fn crlf_across_a_chunk_boundary_still_posts_one_line_break() {
    let text = format!("{}\r\ntail", "a".repeat(TEXT_CHUNK_UTF16 - 1));
    let chunks = text_chunks(&text, None).unwrap();

    let expected = format!("{}\rtail", "a".repeat(TEXT_CHUNK_UTF16 - 1));
    assert_eq!(String::from_utf16(&chunks.concat()).unwrap(), expected);
    assert_eq!(planned_chunk_count(&text).unwrap(), chunks.len());
}

#[test]
fn verify_failure_after_partial_delivery_enriches_chunk_counts() {
    sink::reset();
    let text = "a".repeat(TEXT_CHUNK_UTF16 * 2 + 3);
    let mut calls = 0_usize;

    let error = synthesize_text(&text, ample_deadline(), |_| {
        calls += 1;
        if calls >= 2 {
            return Err(AdapterError::new(
                ErrorCode::ActionFailed,
                "Focus lost between chunks",
            ));
        }
        Ok(())
    })
    .expect_err("verify must fail on second chunk");

    assert_eq!(error.code, ErrorCode::ActionFailed);
    assert_eq!(error.disposition, DeliverySemantics::delivered_unverified());
    let details = error.details.expect("chunk accounting");
    assert_eq!(details["delivered_chunks"], 1);
    assert_eq!(details["total_chunks"], 3);
    assert!(!sink::recorded().is_empty());
}

#[test]
fn verify_failure_before_first_chunk_posts_zero_injection() {
    sink::reset();

    let error = synthesize_text("hello", ample_deadline(), |_| {
        Err(AdapterError::new(
            ErrorCode::ActionFailed,
            "Focus lost before first chunk",
        ))
    })
    .expect_err("verify must fail closed");

    assert_eq!(error.code, ErrorCode::ActionFailed);
    let details = error.details.expect("chunk accounting");
    assert_eq!(details["delivered_chunks"], 0);
    assert_eq!(details["total_chunks"], 1);
    assert!(sink::recorded().is_empty());
}

/// No typed-text leak, inverted: a marker payload driven through every
/// `type_text` error arm must appear in none of the error's textual fields.
#[test]
fn no_type_text_error_arm_echoes_the_typed_payload() {
    const MARKER: &str = "sekrit-marker-value-does-not-appear-anywhere";

    let oversized = format!("{}{}", MARKER, "x".repeat(MAX_TEXT_UTF16 + 1));
    let oversized_error = synthesize_text(&oversized, ample_deadline(), |_| Ok(()))
        .expect_err("oversized payload rejects");
    assert_error_never_mentions(&oversized_error, MARKER);

    let tight_deadline_text = format!("{MARKER}payload");
    let tight_deadline_error = preflight_text(&tight_deadline_text, Deadline::after(1).unwrap())
        .expect_err("impossible deadline rejects");
    assert_error_never_mentions(&tight_deadline_error, MARKER);

    let deadline = Deadline::after(1).unwrap();
    std::thread::sleep(Duration::from_millis(15));
    let mid_error = ensure_chunk_budget(deadline, 5, 2).expect_err("expired deadline rejects");
    assert_error_never_mentions(&mid_error, MARKER);
}

fn assert_error_never_mentions(error: &AdapterError, marker: &str) {
    assert!(
        !error.message.contains(marker),
        "message leaked the payload"
    );
    if let Some(suggestion) = &error.suggestion {
        assert!(
            !suggestion.contains(marker),
            "suggestion leaked the payload"
        );
    }
    if let Some(detail) = &error.platform_detail {
        assert!(
            !detail.contains(marker),
            "platform_detail leaked the payload"
        );
    }
    if let Some(details) = &error.details {
        let serialized = details.to_string();
        assert!(!serialized.contains(marker), "details leaked the payload");
    }
}
