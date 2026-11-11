use super::*;

const INTEGRITY_RID_LOW: u32 = 0x1000;
const INTEGRITY_RID_MEDIUM: u32 = 0x2000;
const INTEGRITY_RID_HIGH: u32 = 0x3000;

#[test]
fn a_caller_strictly_higher_than_the_target_permits_input() {
    assert!(integrity_permits_input(
        INTEGRITY_RID_HIGH,
        INTEGRITY_RID_MEDIUM
    ));
}

#[test]
fn equal_integrity_permits_input() {
    assert!(integrity_permits_input(
        INTEGRITY_RID_MEDIUM,
        INTEGRITY_RID_MEDIUM
    ));
}

/// Inverted: the same pair, read the other direction, must not permit.
#[test]
fn a_target_strictly_higher_than_the_caller_does_not_permit_input() {
    assert!(!integrity_permits_input(
        INTEGRITY_RID_MEDIUM,
        INTEGRITY_RID_HIGH
    ));
}

#[test]
fn target_higher_than_caller_is_denied_with_the_exact_platform_detail_format() {
    let error = evaluate_integrity_gate(Some(INTEGRITY_RID_MEDIUM), Some(INTEGRITY_RID_HIGH))
        .expect_err("a strictly higher target must be denied");

    assert_eq!(error.code, ErrorCode::PermDenied);
    assert_eq!(
        error.platform_detail.as_deref(),
        Some("COM HRESULT 0x80070005 (E_ACCESSDENIED: Access is denied)")
    );
    assert_eq!(
        error.details.expect("denial carries details")["raw_input_emitted"],
        false
    );
    assert!(error.suggestion.is_some());
}

#[test]
fn activation_elevation_denied_is_activation_worded_not_input_worded() {
    let error = activation_elevation_denied();
    assert_eq!(error.code, ErrorCode::PermDenied);
    assert!(
        error.message.contains("window activation"),
        "got {}",
        error.message
    );
    assert!(!error.message.contains("blocks input"));
    assert_eq!(
        error.platform_detail.as_deref(),
        Some("COM HRESULT 0x80070005 (E_ACCESSDENIED: Access is denied)")
    );
    assert_eq!(
        error.details.expect("denial carries details")["physical_delivery_started"],
        false
    );
}

/// Inverted against the denial above: caller-higher and equal both allow.
#[test]
fn caller_higher_or_equal_is_allowed() {
    assert!(evaluate_integrity_gate(Some(INTEGRITY_RID_HIGH), Some(INTEGRITY_RID_MEDIUM)).is_ok());
    assert!(
        evaluate_integrity_gate(Some(INTEGRITY_RID_MEDIUM), Some(INTEGRITY_RID_MEDIUM)).is_ok()
    );
}

/// An unreadable target integrity is never asserted same-integrity -
/// injection proceeds best-effort rather than a fabricated verdict.
#[test]
fn an_unreadable_target_integrity_proceeds_best_effort() {
    assert!(evaluate_integrity_gate(Some(INTEGRITY_RID_MEDIUM), None).is_ok());
}

/// The symmetric case: an unreadable caller integrity also proceeds
/// best-effort rather than assuming the worst.
#[test]
fn an_unreadable_caller_integrity_proceeds_best_effort() {
    assert!(evaluate_integrity_gate(None, Some(INTEGRITY_RID_HIGH)).is_ok());
}

/// Neither side readable: still best-effort, never a fabricated denial.
#[test]
fn both_integrity_levels_unreadable_proceeds_best_effort() {
    assert!(evaluate_integrity_gate(None, None).is_ok());
}

#[cfg(target_os = "windows")]
mod windows_only {
    use super::*;
    use agent_desktop_core::ProcessId;
    use windows_sys::Win32::Security::{
        CreateWellKnownSid, SECURITY_MAX_SID_SIZE, WinHighLabelSid, WinLowLabelSid,
        WinMediumLabelSid,
    };

    /// A real `GetTokenInformation` call against this process's own token -
    /// the local read A20-1 measured is always available, proving the read
    /// path without a manufactured boundary.
    #[test]
    fn local_self_token_read_returns_this_process_integrity() {
        let rid = imp::current_process_integrity_rid();

        assert!(
            rid.is_some(),
            "this process must always be able to read its own token integrity"
        );
    }

    /// The public entry point, called with this process as its own target:
    /// same-or-equal integrity, so the gate must allow it without a
    /// manufactured cross-boundary target.
    #[test]
    fn ensure_target_integrity_allows_input_permits_the_calling_process_as_its_own_target() {
        let pid = ProcessId::from(std::process::id());

        assert!(ensure_target_integrity_allows_input(pid).is_ok());
    }

    /// A target process id that cannot be opened (already exited) leaves
    /// its integrity unreadable, which must proceed best-effort rather
    /// than deny.
    #[test]
    fn ensure_target_integrity_allows_input_is_best_effort_for_an_unreadable_target() {
        let unreadable = ProcessId::from(u32::MAX);

        assert!(ensure_target_integrity_allows_input(unreadable).is_ok());
    }

    /// Synthetic integrity SIDs, built the same way Windows itself builds a
    /// mandatory label (`CreateWellKnownSid`), drive the extraction and the
    /// comparison without needing a real cross-boundary process: the RID
    /// this crate reads off each synthetic SID matches the documented
    /// mandatory-label constant, and feeding those RIDs into the gate
    /// reproduces the allow/deny split the live boundary cannot exercise
    /// here.
    #[test]
    fn synthetic_integrity_sids_extract_the_documented_rid_and_drive_the_gate() {
        let low = synthetic_integrity_rid(WinLowLabelSid);
        let medium = synthetic_integrity_rid(WinMediumLabelSid);
        let high = synthetic_integrity_rid(WinHighLabelSid);

        assert_eq!(low, INTEGRITY_RID_LOW);
        assert_eq!(medium, INTEGRITY_RID_MEDIUM);
        assert_eq!(high, INTEGRITY_RID_HIGH);

        assert!(evaluate_integrity_gate(Some(high), Some(medium)).is_ok());
        assert!(
            evaluate_integrity_gate(Some(medium), Some(high))
                .is_err_and(|error| error.code == ErrorCode::PermDenied)
        );
    }

    fn synthetic_integrity_rid(well_known: i32) -> u32 {
        let mut storage = [0_u64; 9];
        let mut size: u32 = SECURITY_MAX_SID_SIZE;
        let created = unsafe {
            CreateWellKnownSid(
                well_known,
                std::ptr::null_mut(),
                storage.as_mut_ptr().cast(),
                &mut size,
            )
        };
        assert_ne!(
            created, 0,
            "CreateWellKnownSid must build a synthetic integrity SID"
        );
        imp::sid_last_sub_authority(storage.as_mut_ptr().cast())
            .expect("a freshly built well-known SID must expose its RID")
    }
}
