use super::*;
use crate::adapter::{ActionOps, InputOps, ObservationOps, SystemOps};
use crate::system::launch_options::LaunchOptions;
use crate::{AdapterError, AppInfo, InteractionLease, ProcessId, WindowInfo, WindowState};
use std::sync::atomic::{AtomicU64, AtomicUsize, Ordering};

struct LaunchAdapter {
    lease_timeout_ms: AtomicU64,
    list_apps_calls: AtomicUsize,
}

impl ObservationOps for LaunchAdapter {
    fn list_apps(&self, _deadline: crate::Deadline) -> Result<Vec<AppInfo>, AdapterError> {
        self.list_apps_calls.fetch_add(1, Ordering::SeqCst);
        Ok(Vec::new())
    }
}
impl ActionOps for LaunchAdapter {}
impl InputOps for LaunchAdapter {}

impl SystemOps for LaunchAdapter {
    fn acquire_interaction_lease(
        &self,
        deadline: crate::Deadline,
    ) -> Result<InteractionLease, AdapterError> {
        self.lease_timeout_ms
            .store(deadline.timeout_ms(), Ordering::SeqCst);
        InteractionLease::guarded(deadline, ())
    }

    fn launch_app(
        &self,
        _id: &str,
        _options: &LaunchOptions,
        _lease: &InteractionLease,
    ) -> Result<crate::system::launch_result::LaunchResult, AdapterError> {
        Ok(crate::system::launch_result::LaunchResult {
            app: "Fixture".into(),
            pid: ProcessId::new(42),
            process_instance: Some("42:1".into()),
            window: Some(WindowInfo {
                id: "w-1".into(),
                title: "Fixture".into(),
                app: "Fixture".into(),
                pid: ProcessId::new(42),
                process_instance: Some("42:1".into()),
                bounds: None,
                state: WindowState::default(),
            }),
            cdp: None,
            renderer: None,
            suggestion: None,
        })
    }
}

#[test]
fn launch_lease_uses_the_requested_timeout() {
    let adapter = LaunchAdapter {
        lease_timeout_ms: AtomicU64::new(0),
        list_apps_calls: AtomicUsize::new(0),
    };
    let options = LaunchOptions {
        timeout_ms: 30_000,
        ..Default::default()
    };

    execute(
        LaunchArgs {
            app: "Fixture".into(),
            options,
        },
        &adapter,
    )
    .unwrap();

    assert_eq!(adapter.lease_timeout_ms.load(Ordering::SeqCst), 30_000);
}

#[test]
fn zero_launch_timeout_keeps_a_bounded_lease_for_the_single_attempt() {
    let adapter = LaunchAdapter {
        lease_timeout_ms: AtomicU64::new(0),
        list_apps_calls: AtomicUsize::new(0),
    };

    execute(
        LaunchArgs {
            app: "Fixture".into(),
            options: LaunchOptions {
                timeout_ms: 0,
                ..Default::default()
            },
        },
        &adapter,
    )
    .unwrap();

    assert_eq!(
        adapter.lease_timeout_ms.load(Ordering::SeqCst),
        crate::Deadline::standard().unwrap().timeout_ms()
    );
}

/// A launch that never asks for `--cdp` must cost nothing extra: no
/// running-app lookup, no argument mutation. Regression guard against the
/// cdp precheck accidentally running unconditionally.
#[test]
fn plain_launch_without_cdp_never_calls_list_apps() {
    let adapter = LaunchAdapter {
        lease_timeout_ms: AtomicU64::new(0),
        list_apps_calls: AtomicUsize::new(0),
    };

    execute(
        LaunchArgs {
            app: "Fixture".into(),
            options: LaunchOptions::default(),
        },
        &adapter,
    )
    .unwrap();

    assert_eq!(adapter.list_apps_calls.load(Ordering::SeqCst), 0);
}
