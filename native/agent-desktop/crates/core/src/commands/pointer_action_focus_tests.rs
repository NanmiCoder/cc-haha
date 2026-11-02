use super::*;

struct MinimizedWindowAdapter {
    restored: std::sync::atomic::AtomicBool,
    keeps_it_hidden: bool,
    scrolls: AtomicU32,
}

impl MinimizedWindowAdapter {
    fn new(keeps_it_hidden: bool) -> Self {
        Self {
            restored: std::sync::atomic::AtomicBool::new(false),
            keeps_it_hidden,
            scrolls: AtomicU32::new(0),
        }
    }
}

impl ObservationOps for MinimizedWindowAdapter {
    fn resolve_element_strict(
        &self,
        _entry: &RefEntry,
        _deadline: crate::Deadline,
    ) -> Result<NativeHandle, AdapterError> {
        Ok(NativeHandle::null())
    }

    fn observe_pointer(
        &self,
        _handle: &NativeHandle,
        _deadline: crate::Deadline,
    ) -> Result<crate::PointerObservation, AdapterError> {
        let states = if self.restored.load(Ordering::SeqCst) {
            Vec::new()
        } else {
            vec![crate::tree::state::OFFSCREEN.to_string()]
        };
        Ok(crate::PointerObservation {
            bounds: Some(Rect {
                x: 10.0,
                y: 20.0,
                width: 40.0,
                height: 60.0,
            }),
            states,
        })
    }
}

impl ActionOps for MinimizedWindowAdapter {
    fn scroll_into_view(
        &self,
        _handle: &NativeHandle,
        _lease: &crate::InteractionLease,
    ) -> Result<(), AdapterError> {
        self.scrolls.fetch_add(1, Ordering::SeqCst);
        if self.restored.load(Ordering::SeqCst) {
            return Ok(());
        }
        Err(AdapterError::new(
            ErrorCode::ActionFailed,
            "The window manager reports the window hidden and kept it so",
        )
        .with_disposition(DeliverySemantics::not_delivered()))
    }
}

impl InputOps for MinimizedWindowAdapter {}

impl SystemOps for MinimizedWindowAdapter {
    crate::adapter::guarded_interaction_lease!();

    fn resolve_window_strict(
        &self,
        window: &crate::WindowInfo,
        _deadline: crate::Deadline,
    ) -> Result<crate::WindowInfo, AdapterError> {
        Ok(window.clone())
    }

    fn focus_window(
        &self,
        _window: &crate::WindowInfo,
        _lease: &crate::InteractionLease,
    ) -> Result<(), AdapterError> {
        if self.keeps_it_hidden {
            return Err(AdapterError::new(
                ErrorCode::ActionNotSupported,
                "The minimized window was not brought back",
            )
            .with_disposition(DeliverySemantics::delivered_unverified()));
        }
        self.restored.store(true, Ordering::SeqCst);
        Ok(())
    }
}

fn headed_point_args(
    snapshot_id: &str,
) -> crate::commands::point_resolve::PointResolveArgs<'static> {
    crate::commands::point_resolve::PointResolveArgs {
        headed_requirement: crate::HeadedRequirement::FocusedWindowAndCursor,
        ..point_args(snapshot_id)
    }
}

#[test]
fn a_minimized_source_window_is_restored_before_the_wait_scrolls_its_target() {
    let _guard = HomeGuard::new();
    let snapshot_id = point_ref_snapshot();
    let adapter = MinimizedWindowAdapter::new(false);

    let resolved = wait_for_point_with_deadline(
        headed_point_args(&snapshot_id),
        crate::Deadline::after(5_000).unwrap(),
        &adapter,
        &crate::CommandContext::default().with_headed(true),
    )
    .unwrap();

    assert_eq!((resolved.point.x, resolved.point.y), (30.0, 50.0));
    assert!(adapter.restored.load(Ordering::SeqCst));
}

#[test]
fn a_window_the_manager_keeps_hidden_ends_the_wait_with_the_focus_refusal() {
    let _guard = HomeGuard::new();
    let snapshot_id = point_ref_snapshot();
    let adapter = MinimizedWindowAdapter::new(true);

    let err = match wait_for_point_with_deadline(
        headed_point_args(&snapshot_id),
        crate::Deadline::after(5_000).unwrap(),
        &adapter,
        &crate::CommandContext::default().with_headed(true),
    ) {
        Ok(_) => panic!("a window that stays hidden has no point to aim at"),
        Err(err) => err,
    };

    assert_eq!(err.code(), "ACTION_NOT_SUPPORTED");
    assert_eq!(adapter.scrolls.load(Ordering::SeqCst), 0);
}
