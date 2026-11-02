use agent_desktop_core::{AdapterError, DeliveryDisposition, ErrorCode, RetryDisposition};

use super::*;
use crate::system::{NAME_HAS_NO_OWNER, SERVICE_UNKNOWN};
use crate::tree::live::test_support::{client_timeout, method_error};
use crate::tree::properties::absence::{UNKNOWN_INTERFACE, UNKNOWN_METHOD, UNKNOWN_OBJECT};

const FAILED: &str = "org.freedesktop.DBus.Error.Failed";
const UNMAPPED: &str = "org.gtk.GDBus.UnmappedGError.Quark._g_2dio_2derror_2dquark.Code99";
const NO_SUCH_ACTION: &str = "org.gtk.GDBus.UnmappedGError.Quark._g_2dio_2derror_2dquark.Code13";

fn fault(name: &str) -> Fault {
    fault_of(&method_error(name))
}

fn delivery(error: &AdapterError) -> (DeliveryDisposition, RetryDisposition) {
    (error.disposition.delivery(), error.disposition.retry())
}

fn abort_of(verdict: Verdict) -> Abort {
    match verdict {
        Verdict::Abort(abort) => abort,
        Verdict::Absent => panic!("expected an abort"),
    }
}

#[test]
fn each_error_name_lands_in_its_row_of_the_table() {
    let rows = [
        (NAME_HAS_NO_OWNER, Fault::AppGone),
        (SERVICE_UNKNOWN, Fault::AppGone),
        (UNKNOWN_OBJECT, Fault::ObjectUnknown),
        (UNKNOWN_METHOD, Fault::InterfaceMissing),
        (UNKNOWN_INTERFACE, Fault::InterfaceMissing),
        (
            "org.freedesktop.DBus.Error.NotSupported",
            Fault::Unsupported,
        ),
        (
            "org.freedesktop.DBus.Error.PropertyReadOnly",
            Fault::Unsupported,
        ),
        (
            "org.freedesktop.DBus.Error.UnknownProperty",
            Fault::Unsupported,
        ),
        ("org.freedesktop.DBus.Error.InvalidArgs", Fault::InvalidArgs),
        (
            "org.freedesktop.DBus.Error.AccessDenied",
            Fault::AccessDenied,
        ),
        ("org.freedesktop.DBus.Error.NoReply", Fault::TimedOut),
        (FAILED, Fault::Uncertain),
        (UNMAPPED, Fault::Uncertain),
        (NO_SUCH_ACTION, Fault::NoSuchAction),
    ];
    for (name, expected) in rows {
        assert_eq!(fault(name), expected, "{name}");
    }
}

#[test]
fn a_client_timeout_and_a_dropped_connection_are_both_uncertain() {
    assert_eq!(fault_of(&client_timeout()), Fault::TimedOut);
    let dropped = zbus::Error::InputOutput(std::sync::Arc::new(std::io::Error::from(
        std::io::ErrorKind::BrokenPipe,
    )));
    assert_eq!(fault_of(&dropped), Fault::Uncertain);
    for fault in [Fault::TimedOut, Fault::Uncertain] {
        let abort = abort_of(classify_write(
            fault,
            WriteKind::DoAction,
            Corroboration::Alive,
        ));
        let error = abort_error(abort, WriteKind::DoAction, None);
        assert_eq!(
            delivery(&error),
            (
                DeliveryDisposition::DeliveryUncertain,
                RetryDisposition::Unsafe
            )
        );
    }
}

#[test]
fn a_suspect_error_on_an_advertised_interface_is_decided_by_the_corroboration() {
    for fault in [Fault::ObjectUnknown, Fault::InterfaceMissing] {
        let decide = |corroboration| classify_write(fault, WriteKind::DoAction, corroboration);
        assert_eq!(decide(Corroboration::Alive), Verdict::Absent);
        assert_eq!(decide(Corroboration::Dead), Verdict::Abort(Abort::Stale));
        assert_eq!(
            decide(Corroboration::TimedOut),
            Verdict::Abort(Abort::Unconfirmed)
        );
        assert_eq!(
            decide(Corroboration::NotRead),
            Verdict::Abort(Abort::Unconfirmed)
        );
    }
}

#[test]
fn each_write_error_row_carries_its_code_and_disposition() {
    let safe = (DeliveryDisposition::NotDelivered, RetryDisposition::Safe);
    let uncertain = (
        DeliveryDisposition::DeliveryUncertain,
        RetryDisposition::Unsafe,
    );
    let rows = [
        (Fault::AppGone, ErrorCode::StaleRef, safe),
        (Fault::InvalidArgs, ErrorCode::InvalidArgs, safe),
        (Fault::AccessDenied, ErrorCode::PermDenied, safe),
        (Fault::TimedOut, ErrorCode::Timeout, uncertain),
        (Fault::Uncertain, ErrorCode::ActionFailed, uncertain),
    ];
    for (fault, code, expected) in rows {
        let abort = abort_of(classify_write(
            fault,
            WriteKind::DoAction,
            Corroboration::Alive,
        ));
        let error = abort_error(abort, WriteKind::SetProperty, None);
        assert_eq!(error.code, code, "{fault:?}");
        assert_eq!(delivery(&error), expected, "{fault:?}");
    }
    let dead = abort_of(classify_write(
        Fault::ObjectUnknown,
        WriteKind::DoAction,
        Corroboration::Dead,
    ));
    assert_eq!(
        abort_error(dead, WriteKind::DoAction, None).code,
        ErrorCode::StaleRef
    );
    let unknown = abort_error(Abort::Unconfirmed, WriteKind::DoAction, None);
    assert_eq!(unknown.code, ErrorCode::ActionFailed);
    assert_eq!(delivery(&unknown), safe);
}

#[test]
fn a_spent_deadline_is_uncertain_only_once_the_message_was_sent() {
    let before = deadline_error(AdapterError::timeout("spent"), false);
    assert_eq!(before.code, ErrorCode::Timeout);
    assert_eq!(
        delivery(&before),
        (DeliveryDisposition::NotDelivered, RetryDisposition::Safe)
    );
    let after = deadline_error(AdapterError::timeout("spent"), true);
    assert_eq!(after.code, ErrorCode::Timeout);
    assert_eq!(
        delivery(&after),
        (
            DeliveryDisposition::DeliveryUncertain,
            RetryDisposition::Unsafe
        )
    );
}

#[test]
fn a_text_write_error_keeps_the_error_name_and_drops_the_reply_text() {
    let call = zbus::Message::method_call("/probe", "Probe")
        .and_then(|builder| builder.build(&()))
        .expect("a call builds");
    let reply = zbus::Message::error(&call.header(), FAILED)
        .and_then(|builder| builder.build(&("echo of hunter2",)))
        .expect("a reply builds");
    let source = zbus::Error::MethodError(
        FAILED.try_into().expect("a valid name"),
        Some("echo of hunter2".to_owned()),
        reply,
    );
    let text = abort_error(Abort::Uncertain, WriteKind::SetTextContents, Some(&source));
    assert_eq!(text.platform_detail.as_deref(), Some(FAILED));
    let plain = abort_error(Abort::Uncertain, WriteKind::DoAction, Some(&source));
    assert!(
        plain
            .platform_detail
            .as_deref()
            .is_some_and(|detail| detail.contains("hunter2"))
    );
}

#[test]
fn a_missing_action_index_falls_through_for_an_action_and_stays_uncertain_for_text() {
    let decide = |kind| classify_write(Fault::NoSuchAction, kind, Corroboration::NotRead);
    assert_eq!(decide(WriteKind::DoAction), Verdict::Absent);
    for kind in [
        WriteKind::InsertText,
        WriteKind::SetTextContents,
        WriteKind::SetProperty,
    ] {
        assert_eq!(decide(kind), Verdict::Abort(Abort::Uncertain), "{kind:?}");
    }
}

fn no_reply(description: &str) -> zbus::Error {
    let call = zbus::Message::method_call("/probe", "Probe")
        .and_then(|builder| builder.build(&()))
        .expect("a call builds");
    let name = "org.freedesktop.DBus.Error.NoReply";
    let reply = zbus::Message::error(&call.header(), name)
        .and_then(|builder| builder.build(&()))
        .expect("a reply builds");
    zbus::Error::MethodError(
        name.try_into().expect("a valid name"),
        Some(description.to_owned()),
        reply,
    )
}

#[test]
fn a_no_reply_is_a_timeout_unless_the_recipient_left_during_the_call() {
    let waited = no_reply("Did not receive a reply");
    assert_eq!(fault_of(&waited), Fault::TimedOut);
    let died = no_reply("Message recipient disconnected from message bus without replying");
    assert_eq!(fault_of(&died), Fault::Uncertain);
}
