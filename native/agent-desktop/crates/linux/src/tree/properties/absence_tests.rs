use agent_desktop_core::ErrorCode;

use super::*;
use crate::system::{NAME_HAS_NO_OWNER, SERVICE_UNKNOWN};
use crate::tree::live::test_support::{client_timeout, method_error};

const FAILED: &str = "org.freedesktop.DBus.Error.Failed";
const INVALID_ARGS: &str = "org.freedesktop.DBus.Error.InvalidArgs";

fn gone_code(error: &zbus::Error, liveness: Liveness) -> Option<ErrorCode> {
    gone_error(error, liveness).map(|error| error.code)
}

#[test]
fn app_loss_outranks_object_and_field_failures() {
    for name in [SERVICE_UNKNOWN, NAME_HAS_NO_OWNER] {
        let error = method_error(name);
        assert_eq!(failure(&error), Failure::AppGone);
        for liveness in [Liveness::Alive, Liveness::TimedOut, Liveness::ObjectGone] {
            assert_eq!(gone_code(&error, liveness), Some(ErrorCode::AppNotFound));
        }
    }
    assert_eq!(
        read_failure(Failure::Suspect, Liveness::AppGone),
        ReadFailure::AppGone
    );
    assert_eq!(
        read_failure(Failure::Other, Liveness::ObjectGone),
        ReadFailure::ObjectGone
    );
}

#[test]
fn suspect_role_failure_corroborates_object_loss_but_an_answer_keeps_it_alive() {
    for name in [UNKNOWN_OBJECT, UNKNOWN_METHOD, UNKNOWN_INTERFACE] {
        let role = method_error(name);
        let liveness = Liveness::of(Some(&role));
        assert_eq!(liveness, Liveness::ObjectGone, "{name}");
        assert_eq!(
            gone_code(&method_error(name), liveness),
            Some(ErrorCode::ElementNotFound),
            "{name}"
        );
    }
    for (name, role_answered) in [
        (UNKNOWN_OBJECT, "Qt Properties.Get(Value)"),
        (UNKNOWN_INTERFACE, "Qt Properties.Get(Value)"),
        (UNKNOWN_METHOD, "GTK4 Text.GetText"),
        (INVALID_ARGS, "GTK4 Properties.Get(Value)"),
        (FAILED, "GTK3 Properties.Get(Value)"),
    ] {
        assert_eq!(
            gone_code(&method_error(name), Liveness::of(None)),
            None,
            "{role_answered}"
        );
    }
}

#[test]
fn timeout_unknown_names_and_undecodable_role_never_prove_object_loss() {
    let timeout = client_timeout();
    assert_eq!(failure(&timeout), Failure::TimedOut);
    let liveness = Liveness::of(Some(&timeout));
    assert_eq!(liveness, Liveness::TimedOut);
    for name in [
        UNKNOWN_OBJECT,
        UNKNOWN_METHOD,
        UNKNOWN_INTERFACE,
        FAILED,
        INVALID_ARGS,
        "org.example.Error.Unheard",
    ] {
        let error = method_error(name);
        if [FAILED, INVALID_ARGS, "org.example.Error.Unheard"].contains(&name) {
            assert_eq!(failure(&error), Failure::Other, "{name}");
            assert_eq!(Liveness::of(Some(&error)), Liveness::Alive, "{name}");
            assert_eq!(gone_code(&error, Liveness::Alive), None, "{name}");
        }
        assert_eq!(gone_code(&error, liveness), None, "{name}");
    }
    assert_eq!(gone_code(&timeout, liveness), None);
    assert_eq!(
        Liveness::of(Some(&zbus::Error::InvalidReply)),
        Liveness::Alive
    );
}

#[test]
fn parent_listing_proves_absence_only_when_a_successful_list_omits_the_address() {
    let sibling = vec![(":1.2".to_owned(), "/other".to_owned())];
    let listed = vec![(":1.2".to_owned(), "/node".to_owned())];
    assert!(!listing_verdict(None, ":1.2", "/node"));
    assert!(listing_verdict(Some(Some(Vec::new())), ":1.2", "/node"));
    assert!(listing_verdict(Some(Some(sibling)), ":1.2", "/node"));
    assert!(!listing_verdict(Some(Some(listed)), ":1.2", "/node"));
    assert!(!listing_verdict(Some(None), ":1.2", "/node"));
}
